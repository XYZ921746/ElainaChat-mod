// 技能（skill）的服务端支持：扫描 / 安装 / 卸载 / 读取 SKILL.md。
//
// ── 技能**不是**插件（这是本模块存在的全部理由）────────────────────────────
//
// 两者容易被混为一谈，但定位完全不同：
//   · **插件（mods/）** 扩展的是**应用本身**：界面插槽、宿主接口、静态资源。
//     它是**代码**（同源执行的第三方 JS），可装可卸，风险面很大。
//   · **技能（SKILL.md）** 是**给 AI 的指令与知识**：一段带 YAML frontmatter
//     （name / description）的 markdown。它是**纯文本**，不注册进应用、不参与运行。
//
// 所以技能**绝不能**混进插件清单（`/mods/index.json`）—— 那会让"装了哪些插件"
// 里冒出本不该在那儿的项，而且两者的卸载方式根本不同（见下）。
// 本模块与 server/mods.mjs 是**平行的两套**，各扫各的目录、各有各的清单接口。
//
// ── 两个来源 ────────────────────────────────────────────────────────────
//
//   ① **本地技能**：`skills/<id>/SKILL.md` —— 直接住在技能根目录。
//   ② **插件随附技能**：插件在自己的 manifest.json 里声明 `"skills": ["skills/<name>"]`，
//      实际文件就**住在那个插件目录内**（`mods/<插件>/skills/<name>/SKILL.md`）。
//
//      为什么让随附技能住在插件目录里（而不是安装时拷进 skills/）：
//        这样"卸载插件"就等于"删掉它的技能" —— **不需要任何额外清理逻辑**，
//        删目录那一刀就把两者一起带走了。反过来（拷进 skills/）会留下孤儿技能：
//        插件删了、技能还在 skills/ 里列着，用户完全不知道它从哪来、该怎么删。
//
// ── 安装的安全规则（与 mods.mjs 完全一致）────────────────────────────────
//
// 上传安装技能同样是"解压第三方 zip"，风险面与装插件一样：
//   · **路径穿越**：zip 里写 `../../web/serve.mjs` 能覆盖宿主代码 ——
//     复用 isUnsafeEntryName + 解析后的绝对路径必须仍在技能目录内（双保险）。
//   · **危险类型**：技能是纯文本，本来**不需要**任何可执行文件；
//     这里沿用插件那套"拦掉 .exe/.dll/.bat…"的黑名单（技能更没必要带它们）。
//   · **体积上限**：防 zip bomb。
// 解压实现**只有一份**（server/zip.mjs），这里通过注入的 unzip 使用它 ——
// 安全修复只该改一处，否则漏一个调用方就是个洞。

import { readdir, stat, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * 技能 **id** 的合法性（镜像 mods.mjs 的 MOD_ID_RE，用于**上传安装**时定目录名）。
 *
 * id 是身份：要进 URL（`/api/skills/<id>/content`）、要拼磁盘路径，所以收得紧
 * （纯 ASCII、无空格）。上传安装时 id 来自 zip 文件名，必须过这一关。
 *
 * 注意它与**扫描时**接受的目录名不同：用户手工放进 skills/ 的目录是可以叫
 *   「插件开发指南」这种中文名的（见 isSafeSkillDirName），那类目录照样要被扫出来 ——
 *   否则"我放了个中文名的技能，列表里却没有"就成了无从排查的问题。
 */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 技能**目录名**的合法性（比 id 宽松，镜像 mods.mjs 的 isSafeModDirName）。
 *
 * 允许中文、空格等常见字符 —— 用户会这样命名技能。只挡掉真正危险/不可用的：
 *   · 路径分隔符 `/` `\` 与 `..`（目录穿越）
 *   · 以 `.` 开头（隐藏目录，且 `.`/`..` 本身）
 *   · Windows 非法字符与控制字符
 *   · 首尾空白与尾随点（Windows 会静默吃掉，导致名字与预期不符）
 */
const SKILL_DIR_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/;
function isSafeSkillDirName(name) {
    const n = String(name || '');
    if (!n || n === '.' || n === '..') return false;
    if (n.startsWith('.')) return false;              // 隐藏目录 / . ..
    if (n !== n.trim()) return false;                 // 首尾空白
    if (/[. ]$/.test(n)) return false;                // 尾随点/空格（Windows 会吃掉）
    if (n.includes('..')) return false;               // 防穿越（配合上面的分隔符检查）
    return SKILL_DIR_RE.test(n);
}

/**
 * 插件 manifest 里 `skills` 声明的**相对路径**是否安全。
 *
 * manifest 是**外部输入**，不能直接信 —— 一个恶意的 `skills: ["../../../web"]`
 * 会让扫描器去读插件目录之外的东西（信息泄露面）。这里逐段挡掉 `.` / `..` /
 * 以 `.` 开头的隐藏段与绝对路径，只允许"插件目录内的普通子路径"。
 */
function isSafeSkillRel(rel) {
    const r = String(rel || '').replace(/\\/g, '/');
    if (!r || r.startsWith('/')) return false;
    for (const seg of r.split('/')) {
        if (!seg || seg === '.' || seg === '..') return false;
        if (seg.startsWith('.')) return false;        // 隐藏段
    }
    return true;
}

/** 技能目录里允许落盘的本机可执行类型（拦掉，避免用户误双击）—— 与 mods.mjs 同一份清单 */
const SKILL_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd',
    '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh', '.app', '.deb', '.rpm',
]);

/** 单个技能解压后体积上限（防 zip bomb）—— 技能是纯文本，64MB 已远超合理范围 */
const SKILL_MAX_BYTES = 64 * 1024 * 1024;

/** 技能说明文件大小上限（与 mods.mjs 的 README 一致） */
const SKILL_MAX_TEXT_BYTES = 256 * 1024;

/**
 * 从 markdown 里取出 frontmatter 的 name / description（**最简**解析）。
 *
 * 只认文件**开头**的 frontmatter（第一个非空白内容是 `---`，到下一个 `---` 为止），
 * 且只取 name / description 两个**单行标量**。刻意不做完整 YAML：
 *   · 完整 YAML 需要引依赖，而技能只是"给 AI 看的一段文本"，取值错了也不影响运行；
 *   · 多行值（`description: |`）用注释说明即可，不值得为它引一套解析器。
 * **永不抛异常**：文件畸形（没 frontmatter / 缺字段）时回落即可 ——
 * 一个坏 SKILL.md 不该让整次扫描挂掉（那会表现为"技能列表整个空了"）。
 *
 * @returns {{name?:string, description?:string}}
 */
function parseFrontmatter(text) {
    const src = String(text || '');
    // `^` 无 m 标志 → 只在字符串开头匹配；允许 BOM 与前置空白
    const m = /^\uFEFF?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
    if (!m) return {};
    const out = {};
    for (const raw of m[1].split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        if (key !== 'name' && key !== 'description') continue;
        let val = line.slice(idx + 1).trim();
        // 去掉成对的引号（frontmatter 作者可能给值加引号）
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}

/**
 * 技能管理器。
 *
 * @param {object} opts
 * @param {string} opts.skillsDir 技能根目录（项目根的 skills/）
 * @param {string} opts.modsDir   插件根目录（用于读插件 manifest 里的 skills 声明）
 * @param {Function} opts.unzip            解压函数（复用 serve.mjs 那份，已含体积/类型校验）
 * @param {Function} opts.isUnsafeEntryName 条目名安全检查（同上）
 * @param {Function} opts.effectiveExt     取"最终落盘名"的扩展名（含 ADS/尾随点防护）
 * @param {Function} opts.log              日志函数
 */
export function createSkillManager({ skillsDir, modsDir, unzip, isUnsafeEntryName, effectiveExt, log = () => {} }) {
    async function exists(p) {
        try { await stat(p); return true; } catch { return false; }
    }

    /** 读一个 SKILL.md 的文本（读不到就给空串，交给 frontmatter 回落） */
    async function readSkillMd(dir) {
        try { return await readFile(path.join(dir, 'SKILL.md'), 'utf8'); }
        catch { return ''; }
    }

    /**
     * 扫描两个来源，返回技能清单。
     *
     * 为什么每次请求都重新扫（不缓存）：与插件同理 —— 用户可能直接在
     * `skills/` 里拷了个目录进去，缓存会让"我刚放的技能没出现"变成长期困惑。
     * 扫描本身很轻（一次 readdir + 读几个 SKILL.md / manifest）。
     *
     * @returns {Promise<{skills: Array<{id, name, description, owner, source, dir}>}>}
     */
    async function scan() {
        const skills = [];

        // ── ① 本地技能：skills/ 的直接子目录，且含 SKILL.md ──
        await mkdir(skillsDir, { recursive: true }).catch(() => {});
        const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            // 目录名用宽松校验（允许中文/空格）—— 见 isSafeSkillDirName 的说明
            if (!isSafeSkillDirName(e.name)) {
                log(`跳过技能目录 ${e.name}：名字含不安全字符或非法形式`);
                continue;
            }
            const dir = path.join(skillsDir, e.name);
            const md = path.join(dir, 'SKILL.md');
            const info = await stat(md).catch(() => null);
            // 没有 SKILL.md 的目录**不是**技能：skills/ 里可能有 users 随手建的杂物
            //   （图片、笔记），不该被当成技能列出来。
            if (!info || !info.isFile()) continue;
            const fm = parseFrontmatter(await readSkillMd(dir));
            skills.push({
                id: e.name,
                name: fm.name || e.name,          // 缺 name → 回落目录名
                description: fm.description || '', // 缺 description → 空串
                // kind 永远是 'knowledge'：技能是**给 AI 的资料**，不是可执行能力。
                //   写进清单里是为了让消费方（前端注册表）能**当场断言**这条边界，
                //   而不是靠"这条接口只会扫文本文件"的隐含前提 —— 扫描结果里出现
                //   任何别的 kind 都说明有人把技能当插件在装了（见本文件顶部说明）。
                kind: 'knowledge',
                owner: null,
                source: 'local',
                dir,
            });
        }

        // ── ② 插件随附技能：读每个插件 manifest 的 skills 声明 ──
        const plugEntries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);
        for (const pe of plugEntries) {
            if (!pe.isDirectory()) continue;
            if (!isSafeSkillDirName(pe.name)) continue;   // index.json 等文件也会被过滤掉（非目录）
            const pluginDir = path.join(modsDir, pe.name);
            let m = null;
            try { m = JSON.parse(await readFile(path.join(pluginDir, 'manifest.json'), 'utf8')); }
            catch { m = null; }
            if (!m || typeof m !== 'object') continue;
            const rels = Array.isArray(m.skills) ? m.skills : [];
            if (!rels.length) continue;
            // owner：manifest.id 优先（它是插件身份），缺失/非法时回落到目录名 —— 与 mods.mjs 一致
            const owner = (typeof m.id === 'string' && m.id.trim()) ? m.id.trim() : pe.name;
            for (const rel of rels) {
                if (typeof rel !== 'string') continue;
                if (!isSafeSkillRel(rel)) {
                    log(`插件 ${owner} 声明的技能路径不安全，已跳过：${rel}`);
                    continue;
                }
                const relNorm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
                const dir = path.join(pluginDir, relNorm);
                const info = await stat(path.join(dir, 'SKILL.md')).catch(() => null);
                if (!info || !info.isFile()) {
                    log(`插件 ${owner} 声明的技能缺少 SKILL.md：${relNorm}`);
                    continue;
                }
                const fm = parseFrontmatter(await readSkillMd(dir));
                skills.push({
                    id: owner + '/' + relNorm,        // 带 owner 前缀，避免与本地技能 id 撞车
                    name: fm.name || relNorm.split('/').pop(),
                    description: fm.description || '',
                    kind: 'knowledge',                // 见上面那条：技能永远是"资料"，不是能力
                    owner,
                    source: 'mod',
                    dir,
                });
            }
        }

        return { skills };
    }

    /**
     * 从**内存里的 zip** 安装本地技能（供「应用内上传」用）。
     *
     * 安全逻辑与 mods.mjs 的 installFromBuffer 完全一致（两者最终走同一套解压循环）——
     * 这是刻意的：安全规则只该有一份。
     *
     * @param {Buffer} buf  zip 内容
     * @param {string} id   技能 id（来自 zip 文件名，会做白名单校验）
     * @returns {Promise<{id, written, skipped}>}
     */
    async function installFromBuffer(buf, id) {
        if (!SKILL_ID_RE.test(id)) throw new Error('技能名不合法：' + id);
        if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
        return writeSkillFiles(buf, id);
    }

    /** 解压并落盘（installFromBuffer 的实现；将来若有"从磁盘 zip 装"也复用它） */
    async function writeSkillFiles(buf, id) {
        // allowScripts: true —— 与装插件同一取舍：解压默认黑名单会把 .js 拦掉，
        // 而技能目录里可能带个辅助脚本（虽然技能本身是纯文本）。危险类型仍全部拦截。
        const { files } = unzip(buf, { allowScripts: true });

        const targetDir = path.join(skillsDir, id);
        // 先清空旧目录：重装时不清会留下上一次安装残留的文件，那些文件没有清单条目、
        // 「删技能」也删不到它们。
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });

        // zip 内可能有一层与技能同名的顶层目录 —— 去掉它，把文件平铺到技能目录
        const topCandidates = new Set(files.map((f) => f.name.split('/')[0]));
        const stripTop = topCandidates.size === 1 && files.every((f) => f.name.includes('/'));

        let written = 0;
        let total = 0;
        const skipped = [];
        for (const f of files) {
            let rel = f.name;
            if (stripTop) rel = rel.slice(rel.indexOf('/') + 1);
            if (!rel || rel.endsWith('/')) continue;
            if (isUnsafeEntryName(rel)) { skipped.push(f.name); continue; }

            const outPath = path.join(targetDir, rel);
            // 双保险：解析后的绝对路径必须仍在技能目录内
            if (outPath !== targetDir && !outPath.startsWith(targetDir + path.sep)) {
                skipped.push(f.name);
                continue;
            }
            // 拦掉本机可执行类型（用 effectiveExt：能识破 x.exe::$DATA 这类写法）
            if (SKILL_BLOCKED_EXT.has(effectiveExt(path.basename(rel)))) {
                skipped.push(f.name);
                continue;
            }
            total += f.data.length;
            if (total > SKILL_MAX_BYTES) {
                await rm(targetDir, { recursive: true, force: true }).catch(() => {});
                throw new Error('技能解压后超过 ' + Math.round(SKILL_MAX_BYTES / 1024 / 1024) + 'MB 上限');
            }
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, f.data);
            written++;
        }
        if (!written) {
            await rm(targetDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('zip 内没有可用文件');
        }
        // 装完必须真的含 SKILL.md，否则这不是一个技能。
        //   为什么要在这里拦、而不是"装完等扫描时自然忽略"：后者会在 skills/ 里留下
        //   一个**空壳目录**（扫描器认不出它），而用户看到的是"安装成功、但列表里没有" ——
        //   正是本项目最忌讳的"装了等于没装"。这里明确报错并回滚，让用户当场就知道包不对。
        if (!(await exists(path.join(targetDir, 'SKILL.md')))) {
            await rm(targetDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('这个 zip 里没有 SKILL.md（技能必须包含一个 SKILL.md）');
        }
        if (skipped.length) log('技能 ' + id + ' 跳过 ' + skipped.length + ' 个不安全/不允许的条目');
        return { id, written, skipped: skipped.length };
    }

    /**
     * 卸载**本地**技能：删除 skills/<id> 目录**以及对应的安装包**。
     *
     * 为什么连 zip 一起删：与插件同理，目录里那份 `xxx.zip` 是"待安装"的源，
     *   只删目录的话下一次扫描会立刻把它装回来（"卸载了又出现"）。
     *
     * 为什么**只允许本地技能**：插件随附的技能住在插件目录里（mods/<插件>/skills/…），
     *   它们**没有独立的生命周期** —— 想单独删掉它就得去动插件目录，而那是插件的卸载路径。
     *   所以这里明确拒绝并告诉用户"要随插件一起卸"，而不是给一个点了也删不掉的按钮。
     *
     * 为什么用 scan() 反查 id 而不是直接拼路径：技能 id 可能是**中文目录名**
     *   （用户手工放的），用 SKILL_ID_RE（严格 ASCII）会把它误挡 —— 于是"我放的中文技能
     *   能看见却卸载不了"。反查则天然覆盖两种来源，并且天然挡住"删一个不存在/越界的 id"。
     */
    async function uninstall(id) {
        const key = String(id || '');
        if (!key) throw new Error('技能名不合法');
        const { skills } = await scan();
        const found = skills.find((s) => s.id === key);
        if (!found) throw new Error('技能不存在：' + key);
        if (found.source === 'mod') {
            throw new Error('这是插件「' + (found.owner || '') + '」随附的技能，请连同该插件一起卸载（技能就住在插件目录里）');
        }
        const dir = found.dir;
        // 双保险：目标必须真的在 skillsDir 下
        if (!dir.startsWith(skillsDir + path.sep)) throw new Error('路径越界');
        await rm(dir, { recursive: true, force: true });
        // 连同安装包一起删（大小写两种扩展名都试）
        for (const ext of ['.zip', '.ZIP']) {
            await rm(path.join(skillsDir, key + ext), { force: true }).catch(() => {});
        }
        await scan();
        return true;
    }

    /**
     * 读某个技能的 SKILL.md（供界面上的「查看」）。
     *
     * 同时支持**本地**与**插件随附**两种 id：
     *   · 本地：id = 目录名
     *   · 随附：id = `<owner>/<rel>`（含斜杠）
     * 用 scan() 反查到它**注册过的**目录再读，于是前端**传不了任意路径** ——
     * 这比"自己拼路径 + 正则校验"更稳（也顺带处理了中文目录名）。
     *
     * 大小上限 256KB：SKILL.md 不该那么大，超了说明传错了文件。
     *
     * @returns {{ok:true, name:string, text:string}|{ok:false, message:string}}
     */
    async function readSkill(id) {
        const key = String(id || '');
        if (!key) return { ok: false, message: '技能名不合法' };
        const { skills } = await scan();
        const found = skills.find((s) => s.id === key);
        if (!found) return { ok: false, message: '技能不存在：' + key };
        const mdPath = path.join(found.dir, 'SKILL.md');
        // 双保险：SKILL.md 必须仍在它所属的根目录内（本地 → skillsDir；随附 → modsDir）
        const base = found.source === 'local' ? skillsDir : modsDir;
        if (!found.dir.startsWith(base + path.sep)) return { ok: false, message: '路径越界' };
        const info = await stat(mdPath).catch(() => null);
        if (!info || !info.isFile()) return { ok: false, message: '该技能没有 SKILL.md' };
        if (info.size > SKILL_MAX_TEXT_BYTES) {
            return { ok: false, message: '技能文件过大（超过 256KB），已拒绝读取' };
        }
        try {
            const text = await readFile(mdPath, 'utf8');
            return { ok: true, name: 'SKILL.md', text };
        } catch (e) {
            return { ok: false, message: '读取失败：' + String((e && e.message) || e) };
        }
    }

    return { scan, installFromBuffer, uninstall, readSkill, SKILL_ID_RE };
}
