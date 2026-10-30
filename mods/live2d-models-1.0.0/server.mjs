// Live2D 模型资源（公共依赖插件）的服务端半边。
// ── 为什么模型单独一个 mod ─────────────────────────────────────────────────
// 与 elaina-avatar 的分工完全一致：**资源与代码分开**。
//   · live2d-models —— 只有模型文件，没有界面（本文件负责"模型存在哪、怎么读写"）
//   · live2d        —— 视频通话的界面与表现，依赖上面这个
// 这样用户可以只换模型不动代码，也能在不需要视频通话时把界面那半卸掉而保留模型。
// ── 四个接口（与拆分前的 /api/live2d/* 一一对应，路径不变）──────────────────
//   GET    /api/live2d/models        列出模型（附 model3.json / exps / motions / vtube）
//   POST   /api/live2d/upload        上传 zip 解压成一个模型目录
//   DELETE /api/live2d/models/<名>   删除模型目录
//   POST   /api/live2d/rename        重命名模型目录（目录名即显示名）
// ── 磁盘位置 ───────────────────────────────────────────────────────────────
// 模型落在**本插件目录下的 models/**（由 server.static 映射到 URL /live2d/models）。
// 拆分前它们在 web/live2d/models/ —— 与 index.html / serve.mjs 同住一个 web/ 下。
// 搬进 mod 目录的意义不只是整齐：**用户上传的内容**从此与**宿主代码目录**在物理上
// 分开，"用户能写的目录"与"能被当代码执行的目录"不再有交集。
// ── 安全（沿用拆分前的全部约束，一条都没放松）─────────────────────────────
//   · 解压用**宿主**的 readZip（经 ctx.utils）—— 安全实现只有一份
//   · 允许模型带 .js？**不允许**。这里不传 allowScripts，默认黑名单会拦掉脚本类
//     （模型是数据，不该带可执行代码；mod 的 zip 才需要 allowScripts，那是另一条路）
//   · 目录名逐段白名单（挡路径穿越、Windows 非法字符、保留设备名）
//   · 解压后每条路径都要仍在目标目录内（双保险）
//   · 体积上限沿用宿主的常量

import path from 'node:path';
import { mkdir, writeFile, readFile, readdir, rm, rename, stat } from 'node:fs/promises';

/** 目录名长度上限（与拆分前一致） */
const MODEL_NAME_MAX = 60;
/** Windows 保留设备名，做目录名会失败 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function register(ctx) {
    // staticDir 必须在装载期调用：它把「URL /live2d/models → 本插件 models/」
    //   登记给宿主，之后静态服务才知道该从哪读。返回的是绝对路径。
    const MODELS_DIR = ctx.staticDir('/live2d/models');
    ctx.log('模型目录：' + MODELS_DIR);

    // 引擎目录（Cubism Core / PIXI / pixi-live2d-display）。
    // 声明为 mime: 'auto' —— 这三个是**代码**，必须按真实 MIME 返回，
    // 否则浏览器因 nosniff 拒绝执行（懒加载脚本会直接失败）。
    // 对比：models/ 是用户上传的**数据**，走默认的二进制流。
    const VENDOR_DIR = ctx.staticDir('/live2d/vendor');
    ctx.log('引擎目录：' + VENDOR_DIR);

    // ── 工具（都是纯函数，从拆分前的 serve.mjs 原样搬来）────────────────────

    /**
     * 递归收集模型目录下所有文件的相对路径（正斜杠分隔）。
     *
     * 表情/动作并不保证放在固定子目录里：Cubism 只规定 *.exp3.json / *.motion3.json
     * 的文件格式，放在哪由模型作者决定。内置的 deepseek 把 50 多个 *.exp3.json
     * 直接堆在模型根目录、动作放在 motions/ —— 早期"只扫 exp/ 子目录"的实现
     * 因此一个都看不到，表现为"打包进去的模型没有表情/动作"。
     * 限制递归深度，避免病态目录树把接口拖慢。
     */
    async function collectModelFiles(dir, prefix = '', depth = 0) {
        if (depth > 3) return [];
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
        const out = [];
        for (const entry of entries) {
            const rel = prefix ? prefix + '/' + entry.name : entry.name;
            if (entry.isDirectory()) out.push(...await collectModelFiles(path.join(dir, entry.name), rel, depth + 1));
            else out.push(rel);
        }
        return out;
    }

    /**
     * 把用户输入的名字洗成合法目录名。
     * 允许中文/空格/emoji；只挡文件系统层面真正不合法的东西。
     * 返回空串表示不可用（调用方给 400）。
     */
    function sanitizeModelDirName(input) {
        let s = String(input == null ? '' : input);
        s = s.replace(/[\u0000-\u001f\u007f]/g, '');          // 控制字符
        s = s.replace(/[\\/:*?"<>|]/g, '_');                  // Windows 非法字符 → 下划线
        s = s.replace(/\s+/g, ' ').trim();                    // 压缩空白
        s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');  // 首尾的点/空格
        if (s.length > MODEL_NAME_MAX) s = s.slice(0, MODEL_NAME_MAX).trim();
        if (!s || s === '.' || s === '..') return '';
        if (WIN_RESERVED.test(s)) return '';
        return s;
    }

    /** 已存在的目录名合法性（去路径分隔符 + 必须落在 MODELS_DIR 内） */
    function safeModelDirName(name) {
        const safe = String(name || '').replace(/[\\/]/g, '');
        if (!safe || safe === '.' || safe === '..') return '';
        const target = path.join(MODELS_DIR, safe);
        return target.startsWith(MODELS_DIR + path.sep) ? safe : '';
    }

    /** 目标名被占用时依次试 " (2)"、" (3)"…；exclude 是自己（原地改名不算冲突） */
    async function uniqueDirName(desired, exclude) {
        const taken = async (n) => {
            if (n === exclude) return false;
            const st = await stat(path.join(MODELS_DIR, n)).catch(() => null);
            return Boolean(st);
        };
        if (!(await taken(desired))) return desired;
        for (let i = 2; i < 1000; i++) {
            const cand = desired + ' (' + i + ')';
            if (!(await taken(cand))) return cand;
        }
        return '';
    }

    // ── ① 列出模型 ─────────────────────────────────────────────────────────

    async function listModels(res) {
        try {
            const entries = await stat(MODELS_DIR).catch(() => null);
            if (!entries) {
                ctx.json(res, 200, { ok: true, models: [] });
                return;
            }
            const dirs = (await readdir(MODELS_DIR, { withFileTypes: true }))
                .filter((d) => d.isDirectory()).map((d) => d.name);
            const models = [];
            for (const name of dirs) {
                let modelJson = null;
                let exps = [];
                let motions = [];
                let vtube = null;
                let icon = null;
                let sizeBytes = 0;
                let fileCount = 0;
                try {
                    const files = await collectModelFiles(path.join(MODELS_DIR, name));
                    fileCount = files.length;
                    // model3.json / vtube.json 优先取根目录下的，避免纹理等子目录里的同名文件抢走
                    const pickRoot = (pred) => files.find((f) => !f.includes('/') && pred(f)) || files.find(pred) || null;
                    modelJson = pickRoot((f) => f.toLowerCase().endsWith('.model3.json'));
                    vtube = pickRoot((f) => f.toLowerCase().endsWith('.vtube.json'));
                    exps = files.filter((f) => f.toLowerCase().endsWith('.exp3.json')).sort();
                    motions = files.filter((f) => f.toLowerCase().endsWith('.motion3.json')).sort();
                    /**
                     * 缩略图：**优先用模型自带的图标**，其次用模型的脸（贴图）。
                     *
                     * 图标是模型自带的，但**命名没有统一约定** —— 实测两个内置模型：
                     *     deepseek/icon.png · 伊蕾娜·默认/ico_lss.png
                     *   所以不能只认 "icon.png"（第一版就是这样，第二个模型靠"任意 png 兜底"
                     *   才碰巧选中）。这里按**可靠性从高到低**挑：
                     *
                     *   ① 名字含 icon/ico/avatar/thumb/preview 的图片 —— 作者给的图标/预览图
                     *      （`ico_lss.png` 靠这条命中，不用再指望兜底）
                     *   ② model3.json 里引用的**贴图**（Textures）—— 那就是模型的脸。
                     *      直接读模型配置拿，而不是猜文件名：贴图在 `X.2048/texture_00.png`
                     *      这类**子目录**里，按扩展名乱找会挑到别的东西。
                     *   ③ 根目录下任意图片（最后的兜底）
                     *
                     *   ⚠️ 刻意**排除**的：
                     *     · 子目录里的文件（`*.2048/` 是 Cubism 纹理目录，里面是拼贴图集，
                     *       单张拿出来是"一排碎脸"，当缩略图很难看）
                     *     · 体积超过 2 MB 的（缩略图不该拖慢列表；真贴图常有几 MB，
                     *       所以第 ② 步只在没有图标时才用，且这里再兜一道体积限制）
                     */
                    const IMG_RE = /\.(png|jpe?g|webp)$/i;
                    const ICON_NAME_RE = /(^|[_\-.])(icon|ico|avatar|thumb|preview)/i;
                    const rootImgs = files.filter((f) => !f.includes('/') && IMG_RE.test(f));

                    // ① 作者的图标/预览图
                    let pickIcon = rootImgs.find((f) => ICON_NAME_RE.test(f)) || null;

                    // ② model3.json 里声明的贴图（模型的脸）
                    if (!pickIcon && modelJson) {
                        try {
                            const cfg = JSON.parse(await readFile(path.join(MODELS_DIR, name, modelJson), 'utf8'));
                            const tex = (cfg && cfg.FileReferences && Array.isArray(cfg.FileReferences.Textures))
                                ? cfg.FileReferences.Textures : [];
                            // 按配置里的**顺序**取第一张（通常是脸）
                            for (const t of tex) {
                                const rel = String(t || '').replace(/\\/g, '/');
                                if (!rel || !IMG_RE.test(rel)) continue;
                                if (files.includes(rel)) { pickIcon = rel; break; }
                            }
                        } catch { /* 配置读不出来就退回兜底 */ }
                    }

                    // ③ 根目录任意图片（排除明显的运行时资源）
                    if (!pickIcon) {
                        pickIcon = rootImgs.find((f) => !/^(texture|mask)/i.test(f)) || rootImgs[0] || null;
                    }

                    // 体积限制：超大图不当缩略图（列表要一次显示多个模型）
                    if (pickIcon) {
                        const st = await stat(path.join(MODELS_DIR, name, pickIcon)).catch(() => null);
                        if (!st || !st.isFile() || st.size > 2 * 1024 * 1024) pickIcon = null;
                    }
                    icon = pickIcon;
                    // 目录体积：卡片上显示"多大"，用户能判断是不是自己传的那个模型
                    for (const f of files) {
                        const st = await stat(path.join(MODELS_DIR, name, f)).catch(() => null);
                        if (st && st.isFile()) sizeBytes += st.size;
                    }
                } catch { /* 跳过坏目录 */ }
                models.push({ name, modelJson, exps, motions, vtube, icon, sizeBytes, fileCount });
            }
            ctx.json(res, 200, { ok: true, models });
        } catch (err) {
            ctx.json(res, 500, { ok: false, message: String((err && err.message) || err) });
        }
    }

    // ── ② 上传模型 zip ─────────────────────────────────────────────────────

    async function handleUpload(req, res) {
        const readZip = ctx.utils.readZip;
        const isUnsafeEntryName = ctx.utils.isUnsafeEntryName;
        const MAX_UPLOAD = ctx.utils.MAX_UPLOAD;
        if (typeof readZip !== 'function') {
            return ctx.json(res, 500, { ok: false, message: '宿主未提供解压工具，无法上传' });
        }
        const chunks = [];
        let total = 0;
        let overflow = false;
        for await (const chunk of req) {
            total += chunk.length;
            if (total > MAX_UPLOAD) { overflow = true; chunks.length = 0; continue; } // 继续读掉剩余数据再回包
            chunks.push(chunk);
        }
        if (overflow) {
            return ctx.json(res, 413, { ok: false, message: `压缩包超过 ${Math.round(MAX_UPLOAD / 1024 / 1024)}MB 上限` });
        }
        try {
            // 不传 allowScripts：模型是**数据**，不该带可执行代码。
            //   默认黑名单会拦掉 .js/.html 等 —— 这正是我们要的
            //   （mod 的 zip 才需要 allowScripts，走的是 server/mods.mjs 那条路）。
            const { files, blocked } = readZip(Buffer.concat(chunks));
            // 展示名 = 顶层文件夹名 或 model3.json 所在文件夹
            let displayName = '';
            const modelFile = files.find((f) => f.name.toLowerCase().endsWith('.model3.json'));
            if (modelFile) {
                const dir = path.posix.dirname(modelFile.name);
                displayName = dir === '.' ? path.posix.basename(modelFile.name, '.model3.json') : dir.split('/').pop();
            }
            if (!displayName) displayName = (files[0].name.split('/')[0] || 'model');
            // 目录名直接用 zip 里的模型名 —— 用户能在文件夹里和界面里对上号。
            // 拿不到合法名字时退回随机 id；重名自动加 " (2)"。
            const wanted = sanitizeModelDirName(displayName);
            const modelName = wanted
                ? await uniqueDirName(wanted, '')
                : 'model_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            if (!modelName) throw new Error('无法为该模型生成合法目录名，请把 zip 里的文件夹改个名字再传');
            const targetDir = path.join(MODELS_DIR, modelName);
            await mkdir(targetDir, { recursive: true });
            // 公共顶层目录（去掉它，把文件平铺到模型目录）
            const topDir = modelFile ? path.posix.dirname(modelFile.name).split('/')[0] : null;
            let written = 0;
            for (const f of files) {
                let rel = f.name;
                if (topDir && rel.startsWith(topDir + '/')) rel = rel.slice(topDir.length + 1);
                else if (topDir === '.') rel = rel.replace(/^\.\//, '');
                if (!rel || isUnsafeEntryName(rel)) continue;
                const outPath = path.join(targetDir, rel);
                // 双保险：解析后的绝对路径必须仍在目标目录内
                if (outPath !== targetDir && !outPath.startsWith(targetDir + path.sep)) continue;
                await mkdir(path.dirname(outPath), { recursive: true });
                await writeFile(outPath, f.data);
                written++;
            }
            if (!written) {
                await rm(targetDir, { recursive: true, force: true }).catch(() => {});
                throw new Error('zip 内没有可用的模型文件（文件类型可能都被拦截了）');
            }
            // 目录名就是显示名，不需要额外记映射
            ctx.json(res, 200, { ok: true, modelName, displayName: modelName, files: written, blocked });
        } catch (err) {
            ctx.json(res, 400, { ok: false, message: String((err && err.message) || err) });
        }
    }

    // ── ③ 删除模型 ─────────────────────────────────────────────────────────

    async function deleteModel(name, res) {
        const safe = String(name || '').replace(/[\\/]/g, '');
        if (!safe) return ctx.json(res, 400, { ok: false, message: '模型名无效' });
        const target = path.join(MODELS_DIR, safe);
        if (!target.startsWith(MODELS_DIR + path.sep)) return ctx.json(res, 403, { ok: false, message: '禁止' });
        try {
            await rm(target, { recursive: true, force: true });
            ctx.json(res, 200, { ok: true, deleted: safe });
        } catch (err) {
            ctx.json(res, 500, { ok: false, message: String((err && err.message) || err) });
        }
    }

    // ── ④ 重命名模型 ───────────────────────────────────────────────────────

    async function renameModel(body, res) {
        const safe = safeModelDirName(body && body.name);
        if (!safe) return ctx.json(res, 400, { ok: false, message: '模型名无效' });
        const oldPath = path.join(MODELS_DIR, safe);
        const info = await stat(oldPath).catch(() => null);
        if (!info || !info.isDirectory()) return ctx.json(res, 404, { ok: false, message: '模型不存在' });

        const desired = sanitizeModelDirName(body && body.displayName);
        if (!desired) return ctx.json(res, 400, { ok: false, message: '名字不能为空（也不能只含 . / \\ : * ? " < > | 这类字符）' });
        if (desired === safe) return ctx.json(res, 200, { ok: true, name: safe, newName: safe, unchanged: true });

        const target = await uniqueDirName(desired, safe);
        if (!target) return ctx.json(res, 500, { ok: false, message: '重名太多，换个名字试试' });
        const newPath = path.join(MODELS_DIR, target);
        if (!newPath.startsWith(MODELS_DIR + path.sep)) return ctx.json(res, 400, { ok: false, message: '名字无效' });

        try {
            await rename(oldPath, newPath);
        } catch (err) {
            // 目标被占用（Windows 上 rename 到已存在目录会失败）或文件被锁
            return ctx.json(res, 500, { ok: false, message: '重命名失败：' + String((err && err.message) || err) });
        }
        ctx.log('模型重命名: ' + safe + ' → ' + target);
        return ctx.json(res, 200, { ok: true, name: safe, newName: target, displayName: target });
    }

    // ── 路由注册（路径与拆分前完全一致，前端不用改）────────────────────────

    ctx.route('GET', '/api/live2d/models', (req, res) => listModels(res));
    ctx.route('POST', '/api/live2d/upload', (req, res) => handleUpload(req, res));
    ctx.route('POST', '/api/live2d/rename', async (req, res) => {
        let body;
        try { body = await ctx.readJson(req); } catch { return ctx.json(res, 400, { ok: false, message: '请求无效' }); }
        return renameModel(body, res);
    });
    // 删除走通配：`/api/live2d/models/<名>`。用 '*' 方法在 handler 里自己判，
    // 因为"名字"是路径参数，写在 route 前缀里表达不了。
    ctx.route('*', '/api/live2d/models', async (req, res, info) => {
        if (req.method !== 'DELETE') return false;      // 其它方法交给上面的 GET 路由
        const rest = String(info.rest || '').replace(/^\/+/, '');
        if (!rest) return ctx.json(res, 400, { ok: false, message: '缺少模型名' });
        return deleteModel(decodeURIComponent(rest), res);
    });

    ctx.log('已就绪（模型目录 ' + path.basename(MODELS_DIR) + '/，4 个接口）');
}
