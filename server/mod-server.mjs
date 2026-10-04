// mod 的**服务端半边**：按 manifest.json 里的 `server` 声明装载路由与"上传目录"。
//
// ── 为什么需要这一层（也给 Live2D 搬迁铺路）────────────────────────────────
//
// Live2D 有四个接口（/api/live2d/upload、/models、/models/:name、/rename）现在硬编码在
// serve.mjs 里。它们要跟着 Live2D 一起搬进 mod，可 mod 系统此前**没有服务端注册机制** ——
// 插件只能加前端代码，服务端能力只能改宿主。
//
// ── ★ 安全：这是 mod 系统最大的风险面 ─────────────────────────────────────
//
// mod 的宿主半边是**在服务端进程里执行第三方 JS**。这比前端那半边严重得多：
// 前端最多同源 XSS（用户自己那台机器上的浏览器），服务端是**文件系统 + 命令执行 + 局域网**。
//
// 所以这里刻意**不开"注册任意路由"的口子**，而是：
//
//   ① 能力必须**在 manifest.json 里声明**（routes / uploads），宿主据此决定放行什么。
//      mod 代码里**不能**临时注册一个没声明过的前缀 —— 声明与实现分离，
//      用户（和人）看清单就知道这个插件要占哪些地址、碰哪些目录。
//   ② 路由前缀必须是 `/api/<段>` 形式，且**逐段白名单字符**（它是 URL，要能安全拼接）。
//   ③ 与宿主已有前缀**撞名直接拒绝**：宿主的路由先分发，撞名的 mod 路由永远收不到请求 ——
//      静默失效正是本项目最忌讳的那类 bug，宁可在装载期报出来。
//   ④ mod 之间撞名也拒绝（先到先得并记录），避免"装了两个插件，另一个悄悄不工作"。
//   ⑤ 上传目录必须落在插件自己的目录内（`..`/绝对路径/符号链接一律拒绝）。
//   ⑥ 单个 mod 装载失败**只标记它自己**（与前端的失败隔离一致）—— 一个坏 mod
//      不能让服务起不来，否则用户连"去设置里关掉它"都做不到。
//
// ── 与前端清单的关系 ──────────────────────────────────────────────────────
//
// 前端那套（mods.js）读的是同一份 manifest.json。`server` 段是**宿主半边**的声明，
// 前端加载器不解释它（也不会因为它而认为插件有问题）。这与 DSH 的
// `dsh.bundle.patch`（宿主半边）+ `dsh.client`（浏览器半边）是同一个分层思路。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stat } from 'node:fs/promises';

/** 插件 id 的合法性（与 server/mods.mjs 保持一致：id 是身份，收得紧） */
const MOD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 允许注册的路由前缀形状：`/api/<段>`，可再跟若干段。
 *
 * ★ 为什么不允许裸 `/api`：那等于把整个接口层交给一个插件（它能吃掉
 *   /api/store、/api/agent/exec 这些）。前缀必须至少落到第二段。
 * ★ 为什么字符收到 `[A-Za-z0-9._-]`：这个串会被拼进 URL 与比较，
 *   允许 `?` `#` `%` 之类会造成"看起来一样、匹配结果不同"的歧义。
 */
const ROUTE_PREFIX_RE = /^\/api\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** 单段相对目录名（uploads 用）：不允许分隔符、不允许 ..、不允许以点开头 */
function isSafeRelDir(rel) {
    const r = String(rel || '').trim();
    if (!r) return false;
    if (r.startsWith('/') || r.startsWith('\\')) return false;
    if (/^[A-Za-z]:/.test(r)) return false;
    const segs = r.split(/[\\/]+/);
    return segs.every((s) => s && s !== '.' && s !== '..' && !s.startsWith('.'));
}

/** 两个前缀是否互相重叠（相等，或一方是另一方的父级） */
function prefixesOverlap(a, b) {
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/**
 * @param {object} opts
 * @param {string} opts.modsDir  插件根目录（web/mods）
 * @param {string[]} opts.hostRoutePrefixes 宿主自己已占用的 /api 前缀（撞名拒绝用）
 * @param {Function} opts.jsonResponse  宿主统一的 JSON 回包（签名同 serve.mjs 的）
 * @param {Function} opts.readJsonBody  宿主统一的 JSON 请求体解析
 * @param {Function} [opts.log]
 */
export function createModServer({
    modsDir,
    hostRoutePrefixes = [],
    hostStaticPrefixes = [],
    jsonResponse,
    readJsonBody,
    // 宿主提供的共享工具。为什么走这里而不是让 mod 自己 import：
    //   · 解压是**安全敏感代码**（路径穿越 / zip bomb / 危险扩展名），项目一贯要求
    //     "实现只有一份"（见 server/zip.mjs 的合并说明）。让每个 mod 各引一份，
    //     等于安全修复要改 N 处，漏一处就是个洞。
    //   · mod 目录与 server/ 的相对位置也不该被 mod 作者操心。
    hostUtils = {},
    log = () => {},
}) {
    /** 已装载的路由：{ modId, method, prefix, handler }，按装载顺序分发 */
    const routes = [];
    /** 已装载的静态映射：{ modId, url, dir } —— URL 前缀 → 插件目录下的子目录 */
    const statics = [];
    /** mod 声明的"用户上传目录"的绝对路径（这些目录一律按二进制流返回，见 serve.mjs） */
    const uploadRoots = new Set();
    /** 每个声明了 server 的 mod 的装载结果：id → { ok, error, routes, uploads, signature } */
    const loaded = new Map();
    let loadedAt = 0;

    /** 归一化 manifest.server；不合法时返回 { error } 而不是抛错（要能报告给用户） */
    function readDeclaration(manifest) {
        const raw = manifest && manifest.server;
        if (raw == null) return null;                      // 没声明服务端半边：正常情况
        if (typeof raw !== 'object' || Array.isArray(raw)) {
            return { error: 'manifest.json 的 server 必须是对象（{ entry, routes, uploads }）' };
        }
        const entry = String(raw.entry || '').trim();
        if (!entry) return { error: 'manifest.json 的 server 缺少 entry（服务端入口文件名）' };
        if (!/\.(mjs|js)$/i.test(entry)) return { error: 'server.entry 必须是 .js / .mjs 文件：' + entry };
        if (!isSafeRelDir(entry)) return { error: 'server.entry 不能含路径成分或 ..：' + entry };

        const routesRaw = raw.routes == null ? [] : raw.routes;
        if (!Array.isArray(routesRaw)) return { error: 'server.routes 必须是字符串数组（路由前缀）' };
        const prefixes = [];
        for (const item of routesRaw) {
            const p = String(item || '').trim();
            if (!ROUTE_PREFIX_RE.test(p)) {
                return { error: 'server.routes 里的「' + p + '」不是合法的路由前缀（应形如 /api/live2d）' };
            }
            if (prefixes.includes(p)) return { error: 'server.routes 里有重复的前缀：' + p };
            prefixes.push(p);
        }

        const uploadsRaw = raw.uploads == null ? [] : raw.uploads;
        if (!Array.isArray(uploadsRaw)) return { error: 'server.uploads 必须是字符串数组（目录名）' };
        const uploads = [];
        for (const item of uploadsRaw) {
            const u = String(item || '').trim();
            if (!isSafeRelDir(u)) return { error: 'server.uploads 里的「' + u + '」不是安全的相对目录名' };
            if (uploads.includes(u)) return { error: 'server.uploads 里有重复的目录：' + u };
            uploads.push(u);
        }

        // static：把**非 /api** 的 URL 前缀映射到自己目录里的某个子目录
        //   例：{ "/live2d/models": "models" } —— 用户上传的模型仍能从
        //   `/live2d/models/<名字>/…` 取到，但文件其实落在 mod 自己的目录里。
        //
        // ★ 为什么需要它：Live2D 的模型 URL 是 `/live2d/models/<名>/`，而磁盘位置要从
        //   `web/live2d/models/` 搬到 `web/mods/live2d/models/`。URL 不变、磁盘变，
        //   于是要有这层映射；顺带把"用户上传内容"与"宿主代码目录"在物理上分开
        //   （前者天然不该和 index.html 住在一起）。
        const staticRaw = raw.static == null ? [] : raw.static;
        const statics = [];
        if (Array.isArray(staticRaw)) {
            // 数组形式收两种写法，因为它们各自解决一件事：
            //   [["/live2d/models", "models"], …]                  ← 紧凑，适合没有额外选项时
            //   [{ url, dir, mime: 'auto' }, …]                    ← 能表达 mime，适合引擎目录
            // 之前只实现了前者，而 manifest 里写的是后者 —— 结果是"声明看着没问题、
            // 运行时整个 static 被拒"，表现为资源全部 404（实测踩到）。
            for (const item of staticRaw) {
                if (Array.isArray(item)) {
                    if (item.length !== 2) return { error: 'server.static 的两元组必须是 [前缀, 目录]' };
                    const r = checkStaticPair(item[0], item[1], statics);
                    if (r) return { error: r };
                } else if (item && typeof item === 'object') {
                    const r = checkStaticPair(item, null, statics);
                    if (r) return { error: r };
                } else {
                    return { error: 'server.static 的数组项必须是 [前缀, 目录] 或 { url, dir, mime }' };
                }
            }
        } else if (staticRaw && typeof staticRaw === 'object') {
            for (const [k, v] of Object.entries(staticRaw)) {
                const r = checkStaticPair(k, v, statics);
                if (r) return { error: r };
            }
        } else {
            return { error: 'server.static 必须是数组或对象（{ "URL前缀": "目录名" }）' };
        }

        return { entry, routes: prefixes, uploads, statics };
    }

    /** 校验一条 static 映射（URL 前缀 + 目录 + MIME 策略），返回错误字符串或 null */
    function checkStaticPair(urlPrefix, dir, acc) {
        // 允许三种写法：
        //   "/live2d/models": "models"                                   ← 默认二进制
        //   ["/live2d/models", "models"]                                 ← 同上
        //   { url: "/live2d/vendor", dir: "vendor", mime: "auto" }       ← 需要真实 MIME 时
        let p; let d; let mime = 'binary';
        if (urlPrefix && typeof urlPrefix === 'object' && !Array.isArray(urlPrefix)) {
            p = String(urlPrefix.url || '').trim();
            d = String(urlPrefix.dir || '').trim().replace(/\\/g, '/');
            if (urlPrefix.mime !== undefined) mime = String(urlPrefix.mime);
        } else {
            p = String(urlPrefix || '').trim();
            d = String(dir || '').trim().replace(/\\/g, '/');
        }
        // mime 只认这两个值。写错时必须**报错而不是回落** ——
        // 回落成 binary 会让引擎脚本因 MIME 错误被浏览器拒绝执行，
        // 而报错信息会明确指向声明本身（"脚本加载失败"那种现象根本联想不到声明写错）。
        if (mime !== 'binary' && mime !== 'auto') {
            return 'server.static 的 mime 只能是 "binary"（默认，用户上传内容）或 "auto"（mod 自带代码），'
                + '收到的是「' + mime + '」';
        }
        // 前缀必须是 / 开头的普通路径段，且**不能是 /api**（那是接口层，有另一套规则）
        if (!/^\/[A-Za-z0-9][A-Za-z0-9._\-]*(?:\/[A-Za-z0-9][A-Za-z0-9._\-]*)*$/.test(p)) {
            return 'server.static 的 URL 前缀「' + p + '」不合法（应形如 /live2d/models）';
        }
        if (p === '/api' || p.startsWith('/api/')) {
            return 'server.static 的前缀「' + p + '」不能落在 /api 下（接口请用 server.routes）';
        }
        if (!isSafeRelDir(d)) return 'server.static 的目录「' + d + '」不是安全的相对目录名';
        if (acc.some((s) => s.url === p)) return 'server.static 里有重复的 URL 前缀：' + p;
        if (acc.some((s) => s.dir === d)) return 'server.static 里有重复的目录：' + d;
        acc.push({ url: p, dir: d, mime });
        return null;
    }

    /** 声明与宿主/其他 mod 撞名时拒绝（返回原因字符串，null = 通过） */
    function checkCollision(modId, decl, takenRoutes, takenStatics) {
        for (const p of decl.routes) {
            for (const h of hostRoutePrefixes) {
                if (prefixesOverlap(p, h)) {
                    return '路由前缀「' + p + '」与宿主已有的「' + h + '」重叠。'
                        + '宿主的路由先分发，这个前缀永远收不到请求 —— 请换一个前缀。';
                }
            }
            for (const t of takenRoutes) {
                if (prefixesOverlap(p, t.prefix)) {
                    return '路由前缀「' + p + '」已被插件「' + t.modId + '」占用（' + t.prefix + '）。'
                        + '两个插件抢同一个地址时，只有一个能工作 —— 请换一个前缀。';
                }
            }
        }
        // static 的 URL 前缀同样不能撞：撞了会让其中一个插件的资源全部 404，
        // 而"图片加载不出来"是最难联想到"地址被别的插件占了"的现象。
        for (const s of (decl.statics || [])) {
            for (const t of takenStatics) {
                if (prefixesOverlap(s.url, t.url)) {
                    return '静态资源前缀「' + s.url + '」与插件「' + t.modId + '」的「' + t.url + '」重叠 —— 请换一个前缀。';
                }
            }
            for (const h of hostStaticPrefixes) {
                if (prefixesOverlap(s.url, h)) {
                    return '静态资源前缀「' + s.url + '」与宿主已有的「' + h + '」重叠 —— 请换一个前缀。';
                }
            }
        }
        return null;
    }

    /**
     * 装载一个 mod 的服务端半边。
     *
     * 装载失败只记录、不抛出 —— 一个坏 mod 不该让服务起不来（前端那半边的
     * 失败隔离是同一个理由，见 mods.js 的说明）。
     */
    async function loadOne(manifest) {
        const modId = manifest.id;
        const dir = path.join(modsDir, manifest.dir || modId);
        const decl = readDeclaration(manifest);
        if (!decl) return null;                            // 没声明：不参与
        if (decl.error) {
            log('[' + modId + '] 服务端半边未装载：' + decl.error);
            loaded.set(modId, { id: modId, ok: false, error: decl.error, routes: [], uploads: [] });
            return null;
        }

        const err = checkCollision(modId, decl, routes, statics);
        if (err) {
            log('[' + modId + '] 服务端半边未装载：' + err);
            loaded.set(modId, { id: modId, ok: false, error: err, routes: [], uploads: [] });
            return null;
        }

        const entryPath = path.join(dir, decl.entry);
        // 双保险：解析后的绝对路径必须仍在插件目录内
        if (entryPath !== dir && !entryPath.startsWith(dir + path.sep)) {
            const e = 'server.entry 解析后越出了插件目录：' + decl.entry;
            log('[' + modId + '] 服务端半边未装载：' + e);
            loaded.set(modId, { id: modId, ok: false, error: e });
            return null;
        }
        const info = await stat(entryPath).catch(() => null);
        if (!info || !info.isFile()) {
            const e = 'server.entry 不存在：' + decl.entry;
            log('[' + modId + '] 服务端半边未装载：' + e);
            loaded.set(modId, { id: modId, ok: false, error: e });
            return null;
        }

        // 这个 mod 本次装载中登记的项（失败时整体回滚，不留半套）
        const added = [];
        const ctx = {
            modId,
            dir,
            log: (...a) => log('[' + modId + '] ' + a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')),
            json: jsonResponse,
            readJson: readJsonBody,
            /**
             * 宿主提供的共享工具（解压 / 危险类型判定 / 读请求体）。
             *
             * ★ 这些**故意**不让 mod 自己 import：解压是安全敏感代码，
             *   项目一贯要求实现只有一份（见 server/zip.mjs 的合并说明）。
             *   mod 拿到的就是宿主那套已加固的实现，安全修复自动对每个 mod 生效。
             */
            utils: hostUtils,
            /**
             * 注册一个路由处理函数。
             *
             * @param {string} method 'GET' / 'POST' / 'DELETE' …，'*' 表示任意方法
             * @param {string} path 具体端点（如 /api/live2d/upload）—— **必须落在**
             *        manifest.server.routes 声明的某个前缀**之内**（相等或子路径）。
             *        声明与实现是两层：声明说"我占这块地址空间"（用户看清单就知道
             *        插件会碰哪些地址），实现才是具体端点。这样校验既严格又不碍事。
             * @param {Function} handler (request, response, info) => boolean|void
             *        info = { pathname, url, rest, modId }；返回 false 表示"我不处理这条"
             */
            route(method, path, handler) {
                const p = String(path || '').trim();
                const m = String(method || 'GET').toUpperCase();
                const withinDeclared = decl.routes.some((d) => p === d || p.startsWith(d + '/'));
                if (!withinDeclared) {
                    throw new Error('路由「' + p + '」没有落在 manifest.json 的 server.routes 声明之内'
                        + '（已声明：' + (decl.routes.join('、') || '无') + '）。'
                        + '声明与实现必须一致，否则用户看清单无法知道插件要占哪些地址。');
                }
                if (!ROUTE_PREFIX_RE.test(p)) throw new Error('路由「' + p + '」不是合法的接口路径');
                if (typeof handler !== 'function') throw new Error('route() 需要处理函数');
                const rec = { modId, method: m, prefix: p, handler };
                routes.push(rec);
                added.push({ kind: 'route', rec });
                return () => {
                    const i = routes.indexOf(rec);
                    if (i >= 0) routes.splice(i, 1);
                };
            },
            /**
             * 声明一个"用户上传内容会落进来"的目录。
             * 这些目录里的文件由宿主按 application/octet-stream 返回 —— 用户上传的
             * zip 里若混入 .html/.svg，被同源渲染就等于给了对方一个 XSS 执行点。
             * @returns {string} 该目录的绝对路径
             */
            uploadDir(rel) {
                const r = String(rel || '').trim().replace(/\\/g, '/');
                if (!decl.uploads.includes(r)) {
                    throw new Error('上传目录「' + r + '」没有在 manifest.json 的 server.uploads 里声明'
                        + '（已声明：' + (decl.uploads.join('、') || '无') + '）');
                }
                const abs = path.join(dir, r);
                if (abs !== dir && !abs.startsWith(dir + path.sep)) {
                    throw new Error('上传目录越出了插件目录：' + r);
                }
                uploadRoots.add(abs);
                added.push({ kind: 'upload', abs });
                return abs;
            },
            /**
             * 声明一条「URL 前缀 → 本插件目录下的子目录」的静态映射。
             *
             * @param {string} url 形如 `/live2d/models`，**必须**在 manifest.server.static 里声明过
             * @returns {string} 该目录的绝对路径
             *
             * 用法（Live2D 模型 mod 就是这么做）：
             *   const dir = ctx.staticDir('/live2d/models');
             *   // 之后往 dir 里读写文件，用户仍从 /live2d/models/<名>/… 取到
             *
             * ★ 为什么目录要落在插件自己名下：模型是**用户上传的内容**，
             *   不该和 index.html / serve.mjs 住在一起。物理分开之后，
             *   "用户能写的目录"与"宿主代码目录"之间就没有交集了。
             */
            staticDir(url) {
                const u = String(url || '').trim();
                const hit = decl.statics.find((s) => s.url === u);
                if (!hit) {
                    throw new Error('静态前缀「' + u + '」没有在 manifest.json 的 server.static 里声明'
                        + '（已声明：' + (decl.statics.map((s) => s.url).join('、') || '无') + '）');
                }
                const abs = path.join(dir, hit.dir);
                if (abs !== dir && !abs.startsWith(dir + path.sep)) {
                    throw new Error('静态目录越出了插件目录：' + hit.dir);
                }
                // 登记到 statics（供 serve.mjs 做 URL → 磁盘 的解析）
                const rec = { modId, url: hit.url, dir: abs, mime: hit.mime || 'binary' };
                statics.push(rec);
                added.push({ kind: 'static', rec });
                return abs;
            },
        };

        try {
            const mod = await import(pathToFileURL(entryPath).href);
            const register = typeof mod.register === 'function' ? mod.register
                : (typeof mod.default === 'function' ? mod.default : null);
            if (!register) {
                throw new Error('服务端入口没有导出 register(ctx) 或 default 函数');
            }
            await register(ctx);
            loaded.set(modId, {
                id: modId, ok: true, entry: decl.entry,
                routes: decl.routes.slice(), uploads: decl.uploads.slice(),
                statics: decl.statics.slice(),
                signature: JSON.stringify(decl),
            });
            log('[' + modId + '] 服务端半边已装载'
                + (decl.routes.length ? '：路由 ' + decl.routes.join('、') : '')
                + (decl.statics.length ? '；静态 ' + decl.statics.map((s) => s.url + '→' + s.dir).join('、') : '')
                + (decl.uploads.length ? '；上传目录 ' + decl.uploads.join('、') : ''));
            return loaded.get(modId);
        } catch (e) {
            // ★ 回滚本次登记：半个装载（注册了 1 个路由、第 2 个抛错）比完全没装载
            //   更难理解 —— 接口一半能用一半 404，而清单上写着"已装载"。
            for (const a of added) {
                if (a.kind === 'route') {
                    const i = routes.indexOf(a.rec);
                    if (i >= 0) routes.splice(i, 1);
                } else if (a.kind === 'static') {
                    const i = statics.indexOf(a.rec);
                    if (i >= 0) statics.splice(i, 1);
                } else {
                    uploadRoots.delete(a.abs);
                }
            }
            const msg = String((e && e.message) || e);
            loaded.set(modId, { id: modId, ok: false, error: msg });
            log('[' + modId + '] 服务端半边装载失败（已隔离，不影响其它插件与服务本身）：' + msg);
            return loaded.get(modId);
        }
    }

    /**
     * 装载全部已安装插件的服务端半边。
     *
     * 什么时候调用：**服务启动时一次**。原因见 status().needsRestart —— 路由是
     * 常驻注册表，装完插件不重启就注册上会让"哪些接口存在"随运行状态漂移，
     * 排查时无法复现。宁可明确告诉用户"重启后生效"。
     *
     * ★ **只看已启用的插件**（2026-10 修的真 bug）。
     *
     *   原先这里对 `installed` 无条件装载，完全不看 `elaina_plugin_<id>` 这个开关 ——
     *   后果是"停用了插件，它的服务端接口照样活着"：用户到设置里把 Live2D 关掉，
     *   前端界面确实消失了，可 `/api/live2d/*` 仍然在响应。这与项目一贯的
     *   "停用要真的停用"直接矛盾（前端那半边是做对了的：见 mods.js 的注册项回收）。
     *
     *   实现方式：把启用状态作为**参数**传进来，而不是在这个模块里读 localStorage ——
     *   它是服务端，读不到浏览器的 localStorage，也不该长着"配置存在哪"的知识。
     *   调用方（serve.mjs）用同一个 store 读出 `elaina_plugins_enabled` 与
     *   `elaina_plugin_<id>`，与前端 Store 是同一份数据，两边判定不会分叉。
     *
     * @param {Array<{id:string, dir:string}>} installed scanAndSync() 给出的清单
     * @param {(id:string, manifest:object)=>boolean} [isEnabled]
     *        该插件是否已启用；缺省视为全部启用（保持旧行为，便于单测与兼容）
     */
    async function loadAll(installed, isEnabled) {
        loadedAt = Date.now();
        const enabled = typeof isEnabled === 'function' ? isEnabled : () => true;
        for (const m of installed || []) {
            if (!enabled(m.id, m)) {
                // 记一条"为什么没装载"，否则用户看到接口 404 会以为插件坏了
                loaded.set(m.id, { id: m.id, ok: false, enabled: false, error: '插件未启用（到「设置 → 插件」打开开关，然后重启服务）' });
                log('[' + m.id + '] 服务端半边未装载：插件未启用');
                continue;
            }
            try { await loadOne(m); }
            catch (e) { log('[' + m.id + '] 装载服务端半边时出现意外：' + String((e && e.message) || e)); }
        }
        return status(installed);
    }

    /**
     * 当前状态：装载了什么、哪些装了但**要重启才生效**。
     *
     * ★ needsRestart 是本轮特意补的一个状态（原先只有 ready/disabled/blocked/error）。
     *   服务端路由与 vendor 库都属于"改了必须重启"的东西，而"静默不生效"
     *   正是本项目反复踩过的那类问题（"装了等于没装"）。
     */
    function status(installed) {
        const mods = [...loaded.values()];
        const needsRestart = [];
        const failed = [];
        if (Array.isArray(installed)) {
            for (const m of installed) {
                const decl = readDeclaration(m);
                if (!decl || decl.error) continue;         // 没声明/声明坏了：由"声明错误"那条路报，不算重启问题
                const cur = loaded.get(m.id);
                if (!cur) {
                    // 启动时还没有它 → 服务端接口要重启才生效。**这不是错误**，
                    // 是加载时机使然，所以与 failed 分开报（用户要做的动作完全不同）。
                    needsRestart.push({ id: m.id, why: '服务启动时还没有这个插件，重启服务后它的服务端接口才会生效' });
                    continue;
                }
                if (cur.ok === false && cur.enabled === false) continue;   // 未启用：不是问题，无需重启
                if (!cur.ok) { failed.push({ id: m.id, error: cur.error }); continue; }
                const sig = JSON.stringify({ entry: decl.entry, routes: decl.routes, uploads: decl.uploads, statics: decl.statics });
                if (cur.signature !== sig) {
                    needsRestart.push({ id: m.id, why: '该插件的服务端声明变了，重启服务后生效' });
                }
            }
        }
        return { loadedAt, mods, needsRestart, failed };
    }

    /**
     * 分发一条 mod 路由。**返回 true 表示这条请求已被处理**（响应也已写出）。
     *
     * 调用位置很重要：必须排在宿主所有路由**之后**、静态文件之前。
     * 排后面是为了让宿主永远优先（撞名在装载期已拒绝，这里是第二道保险）。
     */
    async function handle(request, response, info) {
        const pathname = info.pathname;
        for (const r of [...routes]) {
            if (r.method !== '*' && r.method !== request.method) continue;
            if (pathname !== r.prefix && !pathname.startsWith(r.prefix + '/')) continue;
            const rest = pathname.slice(r.prefix.length);
            try {
                const result = await r.handler(request, response, {
                    pathname, url: info.url, rest, modId: r.modId,
                });
                if (result === false) continue;            // 明确不处理 → 看看后面的路由
                return true;
            } catch (e) {
                // 插件抛错不该把服务带崩，也不该静默 —— 明确回 500 并记日志
                const msg = String((e && e.message) || e);
                log('[' + r.modId + '] 处理 ' + pathname + ' 时出错：' + msg);
                if (!response.headersSent) {
                    jsonResponse(response, 500, { ok: false, message: '插件 ' + r.modId + ' 处理请求失败：' + msg });
                } else {
                    try { response.end(); } catch (e2) { /* 已经发了一半，只能收尾 */ }
                }
                return true;
            }
        }
        return false;
    }

    /**
     * 把一条 URL 路径解析成插件静态目录里的真实文件。
     *
     * 返回 `{ abs, modId }` 或 null（没有匹配的前缀 / 路径穿越 / 不是普通文件）。
     *
     * ★ 安全要点：这是"用户可控路径 → 磁盘文件"的入口，所以
     *   ① 前缀必须**段边界**匹配（`/live2d/models-x` 不该命中 `/live2d/models`）
     *   ② 解析后的绝对路径必须仍在那个映射目录内（挡 `..`、绝对路径、编码绕过）
     *   ③ 交给调用方之前先 decodeURIComponent 再解析 —— 否则 `%2e%2e` 能绕过第 ② 步
     *
     * @param {string} pathname 已解码的 URL 路径
     * @param {Function} [isFile] 判断是否普通文件（由调用方注入 lstat，避免这里再引 fs）
     */
    function resolveStatic(pathname, isFile) {
        const p = String(pathname || '');
        for (const s of statics) {
            if (p !== s.url && !p.startsWith(s.url + '/')) continue;
            let rel = p.slice(s.url.length).replace(/^\/+/, '');
            // 解码后再解析：`%2e%2e%2f` 这类写法必须在**解析之前**变成真实的 `../`
            try { rel = decodeURIComponent(rel); } catch { return null; }
            // 解码后可能出现分隔符/上跳，逐段白名单（与 mods.mjs 的目录校验同口径）
            const segs = rel.split(/[\\/]+/);
            if (segs.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null;
            const abs = path.join(s.dir, ...segs);
            if (abs !== s.dir && !abs.startsWith(s.dir + path.sep)) return null;
            if (typeof isFile === 'function' && !isFile(abs)) return null;
            return { abs, modId: s.modId, dir: s.dir, mime: s.mime || 'binary' };
        }
        return null;
    }

    return {
        loadAll,
        status,
        handle,
        /** 需要按二进制流返回的目录（用户上传内容落地处），供静态服务判断类型 */
        uploadRoots: () => [...uploadRoots],
        /** 插件声明的静态目录（URL 前缀 → 磁盘目录 + MIME 策略），供静态服务解析资源请求 */
        statics: () => statics.map((s) => ({ modId: s.modId, url: s.url, dir: s.dir, mime: s.mime || 'binary' })),
        resolveStatic,
        /** 供测试断言：当前注册的路由前缀 */
        _routes: () => routes.map((r) => ({ modId: r.modId, method: r.method, prefix: r.prefix })),
        readDeclaration,
        MOD_ID_RE,
    };
}
