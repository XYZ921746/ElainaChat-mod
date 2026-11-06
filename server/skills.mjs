// 技能（skill）的服务端支持：扫描 / 安装 / 卸载 / 读取 SKILL.md。技能是给 AI 的纯文本资料，不是插件（同源执行的第三方 JS），两者绝不能混进同一份清单。
// 两个来源：skills/<id>/SKILL.md 与插件 manifest 的 "skills": [...]（文件住在插件目录内，卸载插件即删掉技能，不留孤儿）；解压实现仍只有 zip.mjs 一份。

import { readdir, stat, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

/** 技能 id（镜像 mods.mjs 的 MOD_ID_RE），上传安装时用它定目录名：id 要进 URL（/api/skills/<id>/content）、要拼磁盘路径，所以收得紧；扫描时接受的目录名另用 isSafeSkillDirName（允许中文），否则手工放的中文技能目录会扫不到 */
const SKILL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 技能目录名（比 id 宽松，镜像 mods.mjs 的 isSafeModDirName）：允许中文/空格，只挡路径分隔符与 ..、前导点、Windows 非法字符、会被静默吃掉的尾随点/首尾空白 */
const SKILL_DIR_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/;
export function isSafeSkillDirName(name) {
    const n = String(name || '');
    if (!n || n === '.' || n === '..') return false;
    if (n.startsWith('.')) return false;              // 隐藏目录 / . ..
    if (n !== n.trim()) return false;                 // 首尾空白
    if (/[. ]$/.test(n)) return false;                // 尾随点/空格（Windows 会吃掉）
    if (n.includes('..')) return false;               // 防穿越（配合上面的分隔符检查）
    return SKILL_DIR_RE.test(n);
}

/** 插件 manifest 里 skills 声明是外部输入，不能信：逐段挡掉 . / .. / 隐藏段与绝对路径，只允许插件目录内的普通子路径（否则能读到插件目录之外的东西） */
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
export const SKILL_BLOCKED_EXT = new Set([
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd',
    '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh', '.app', '.deb', '.rpm',
]);

/** 单个技能解压后体积上限（防 zip bomb）—— 技能是纯文本，64MB 已远超合理范围 */
const SKILL_MAX_BYTES = 64 * 1024 * 1024;

/** 技能说明文件大小上限（与 mods.mjs 的 README 一致） */
const SKILL_MAX_TEXT_BYTES = 256 * 1024;

/**
 * 从 markdown 取 frontmatter 的 name / description（最简解析）：只认文件开头的 frontmatter 与两个单行标量 —— 技能只是给 AI 看的一段文本，不值得为多行值引一套 YAML 解析器。
 * 永不抛异常：文件畸形（没 frontmatter / 缺字段）时回落 —— 一个坏 SKILL.md 不该让整次扫描挂掉（那会表现为技能列表整个空了）。
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

/** unzip / isUnsafeEntryName / effectiveExt 复用 serve.mjs 那份（已含体积与类型校验） */
export function createSkillManager({ skillsDir, modsDir, unzip, isUnsafeEntryName, effectiveExt, log = () => {} }) {
    async function exists(p) {
        try { await stat(p); return true; } catch { return false; }
    }

    /** 读一个 SKILL.md 的文本（读不到就给空串，交给 frontmatter 回落） */
    async function readSkillMd(dir) {
        try { return await readFile(path.join(dir, 'SKILL.md'), 'utf8'); }
        catch { return ''; }
    }

    /** 扫描本地技能，返回技能清单；每次请求都重新扫、不缓存 —— 用户可能直接往 skills/ 拷目录，缓存会让"我刚放的技能没出现"变成长期困惑，扫描本身很轻；@returns { skills: [{ id, name, description, owner, source, dir }] } */
    async function scanLocalSkills() {
        const skills = [];
    // ① 本地技能：skills/ 的直接子目录，且含 SKILL.md
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
        // 没有 SKILL.md 的目录不是技能：skills/ 里可能有用户随手建的图片、笔记
        if (!info || !info.isFile()) continue;
        const fm = parseFrontmatter(await readSkillMd(dir));
        skills.push({
            id: e.name,
            name: fm.name || e.name,          // 缺 name → 回落目录名
            description: fm.description || '', // 缺 description → 空串
            // kind 永远是 'knowledge'：写进清单是为了让前端注册表能当场断言这条边界，出现别的 kind 说明有人把技能当插件装了
            kind: 'knowledge',
            owner: null,
            source: 'local',
            dir,
        });
    }

        return skills;
    }

    async function scanModSkills() {
        const skills = [];
    // ② 插件随附技能：读每个插件 manifest 的 skills 声明
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

        return skills;
    }

    /** 扫描两个来源（本地 + 插件随附）并合并成一份清单；不缓存的理由同上 */
    async function scan() {
        const local = await scanLocalSkills();
        const fromMods = await scanModSkills();
        return { skills: local.concat(fromMods) };
    }
    /** 从内存里的 zip 安装本地技能（供应用内上传用）：安全逻辑与 mods.mjs 的 installFromBuffer 一致 —— 两者走同一套解压循环，安全规则只该有一份 */
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
        // 装完必须真的含 SKILL.md：留个空壳目录会让用户看到"安装成功、但列表里没有"，这里明确报错并回滚，让用户当场知道包不对
        if (!(await exists(path.join(targetDir, 'SKILL.md')))) {
            await rm(targetDir, { recursive: true, force: true }).catch(() => {});
            throw new Error('这个 zip 里没有 SKILL.md（技能必须包含一个 SKILL.md）');
        }
        if (skipped.length) log('技能 ' + id + ' 跳过 ' + skipped.length + ' 个不安全/不允许的条目');
        return { id, written, skipped: skipped.length };
    }

    /**
     * 卸载本地技能：删 skills/<id> 目录以及对应的安装包（只删目录的话下一次扫描会立刻把 zip 装回来）。
     * 只允许本地技能：插件随附技能住在插件目录里、没有独立生命周期，明确拒绝而不是给一个点了也删不掉的按钮。
     * 用 scan() 反查 id 而不是直接拼路径：技能 id 可能是中文目录名，SKILL_ID_RE 会误挡（"能看见却卸载不了"）；反查天然覆盖两种来源并挡住越界 id。
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

    /** 读某个技能的 SKILL.md（供界面「查看」）：支持本地 id（目录名）与插件随附 id（<owner>/<rel>），一律用 scan() 反查到注册过的目录再读，前端传不了任意路径；大小上限 256KB，超了说明传错了文件 */
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
