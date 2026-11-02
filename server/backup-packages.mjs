// 备份里的插件与技能：把安装目录按原样收进数据备份 zip，并在导入时写回。
// 为什么不放进 store.mjs：store 管的是 data/ 下的键值，插件与技能是**安装目录**，
// 两者生命周期不同（卸载插件是删目录，不是删键）。让 store 认识它们会把两种
// 语义混在一处；但用户备份时只想拿一个 zip，所以由 serve.mjs 把两边的条目
// 合进同一个包，本模块只负责"目录 ↔ zip 条目"的转换与落盘安全。
// 备份 zip 的顶层三件（解压后与项目根一一对应）：
//   data/…    聊天数据（由 server/store.mjs 写，本模块不碰）
//   mods/…    已安装插件
//   skills/…  本地技能
// 安全边界与安装接口保持一致：
//   · 条目名先过 isUnsafeEntryName（绝对路径 / .. 穿越）
//   · 目录名过各自的宽松白名单（允许中文，但挡掉分隔符与隐藏目录）
//   · 落盘类型过各自的危险扩展名清单（.exe/.dll/.bat…；插件仍允许 .js/.html）
//   · 先写 .restoring-* 临时目录，校验完整后再改名，避免留下半个插件

import { readdir, readFile, stat, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import {
    isUnsafeEntryName as defaultIsUnsafeEntryName,
    effectiveExt as defaultEffectiveExt,
    PLUGIN_EXTS as MOD_PLUGIN_EXTS,
} from './zip.mjs';
import { MOD_BLOCKED_EXT, MOD_ID_RE, isSafeModDirName } from './mods.mjs';
import { SKILL_BLOCKED_EXT, isSafeSkillDirName } from './skills.mjs';

const MODS_PREFIX = 'mods/';
const SKILLS_PREFIX = 'skills/';
/** 安装中途留下的临时目录前缀；扫描器会跳过 . 开头的目录，这里只负责回收 */
const STAGING_PREFIX = '.restoring-';
/** 超过这个年龄的临时目录视为上次中断的残留（避免误删另一个正在进行的导入） */
const STAGING_STALE_MS = 10 * 60 * 1000;

/**
 * 插件与技能的备份读写器。
 *
 * @param {object} opts
 * @param {string} opts.modsDir   插件根目录
 * @param {string} opts.skillsDir 技能根目录
 * @param {(name:string)=>boolean} [opts.isUnsafeEntryName]
 * @param {(name:string)=>string} [opts.effectiveExt]
 * @param {(msg:string)=>void} [opts.log]
 */
export function createPackageBackup({
    modsDir,
    skillsDir,
    isUnsafeEntryName = defaultIsUnsafeEntryName,
    effectiveExt = defaultEffectiveExt,
    log = () => {},
}) {
    async function exists(p) {
        try { await stat(p); return true; } catch { return false; }
    }

    /** 读 manifest.id（缺失/非法时给空串，交给调用方回落目录名） */
    async function readManifestId(file) {
        try {
            const m = JSON.parse(await readFile(file, 'utf8'));
            const id = String((m && m.id) || '').trim();
            return MOD_ID_RE.test(id) ? id : '';
        } catch {
            return '';
        }
    }

    /** 递归列出目录内的普通文件（相对路径，/ 分隔）。符号链接一律跳过。 */
    async function walkFiles(dir, rel = '', out = []) {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            const nextRel = rel ? rel + '/' + e.name : e.name;
            if (e.isSymbolicLink()) {
                log('跳过符号链接：' + path.join(dir, e.name));
                continue;
            }
            if (e.isDirectory()) {
                await walkFiles(path.join(dir, e.name), nextRel, out);
            } else if (e.isFile()) {
                out.push(nextRel);
            }
        }
        return out;
    }

    async function packageDirs(rootDir, isSafeName, requireSkill = false) {
        const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
        const out = [];
        for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            if (!e.isDirectory() || !isSafeName(e.name)) continue;
            const dir = path.join(rootDir, e.name);
            if (requireSkill) {
                const md = await stat(path.join(dir, 'SKILL.md')).catch(() => null);
                if (!md || !md.isFile()) continue;
            }
            out.push({ name: e.name, dir });
        }
        return out;
    }

    /**
     * 收集所有已安装插件与本地技能，返回可直接并入备份 zip 的条目。
     *
     * 只收"目录存在 = 已安装"的包；mods/index.json（扫描生成）与待安装的
     * *.zip 都不收 —— 前者导入后会自动重建，后者是安装源而不是已装内容。
     * 插件随附技能住在插件目录内，会随插件一起进包，不在这里单独复制一份。
     */
    async function collectPackage(rootDir, isSafeName, prefix, requireSkill = false) {
        const entries = [];
        let count = 0;
        for (const pkg of await packageDirs(rootDir, isSafeName, requireSkill)) {
            const files = await walkFiles(pkg.dir);
            if (!files.length) continue;
            count++;
            for (const rel of files) {
                entries.push({ name: prefix + pkg.name + '/' + rel, data: await readFile(path.join(pkg.dir, rel)) });
            }
        }
        return { entries, count };
    }

    async function collect() {
        const mods = await collectPackage(modsDir, isSafeModDirName, MODS_PREFIX);
        const skills = await collectPackage(skillsDir, isSafeSkillDirName, SKILLS_PREFIX, true);
        return {
            entries: [...mods.entries, ...skills.entries],
            counts: { mods: mods.count, skills: skills.count },
        };
    }

    /** 只数数量（/api/data/info 用），不读文件内容 */
    async function counts() {
        const mods = (await packageDirs(modsDir, isSafeModDirName)).length;
        const skills = (await packageDirs(skillsDir, isSafeSkillDirName, true)).length;
        return { mods, skills };
    }

    /** 删除上次中断留下的临时目录（只删足够旧的，避免撞上进行中的导入） */
    async function cleanStaleStaging(rootDir) {
        const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
        const now = Date.now();
        for (const e of entries) {
            if (!e.isDirectory() || !e.name.startsWith(STAGING_PREFIX)) continue;
            const dir = path.join(rootDir, e.name);
            const info = await stat(dir).catch(() => null);
            if (info && now - info.mtimeMs < STAGING_STALE_MS) continue;
            await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * 把 zip 里的 mods/ 与 skills/ 条目按顶层目录分组。
     *
     * files 可能是**全量**条目（含 data/ 与 manifest.json）：不认识的顶层一律跳过，
     * 所以同一个 readZip 结果既能恢复插件，也不会把聊天数据写进 mods/。
     */
    function groupEntries(files, allowScripts = false) {
        const groups = new Map();   // "mods/<目录>" → { kind, name, files: [{rel,data}] }
        let skipped = 0;

        for (const f of files) {
            const rawName = String((f && f.name) || '').replace(/\\/g, '/');
            let kind;
            let rest;
            if (rawName.startsWith(MODS_PREFIX)) {
                kind = 'mods';
                rest = rawName.slice(MODS_PREFIX.length);
            } else if (rawName.startsWith(SKILLS_PREFIX)) {
                kind = 'skills';
                rest = rawName.slice(SKILLS_PREFIX.length);
            } else {
                continue;
            }

            const segs = rest.split('/');
            if (segs.length < 2) { skipped++; continue; }
            const name = segs[0];
            const rel = segs.slice(1).join('/');
            const safeName = kind === 'mods' ? isSafeModDirName(name) : isSafeSkillDirName(name);
            if (!safeName || !rel || isUnsafeEntryName(rel)) { skipped++; continue; }
            if (rel.split('/').some((s) => !s || s === '.')) { skipped++; continue; }
            // 危险类型：插件安装接口放行脚本与 HTML 面板（.js 是插件本体），
            // 技能一律不放行。allowScripts 只在恢复路径上由调用方显式打开。
            const blocked = kind === 'mods' ? MOD_BLOCKED_EXT : SKILL_BLOCKED_EXT;
            const ext = effectiveExt(path.basename(rel));
            if (blocked.has(ext) && !(allowScripts && kind === 'mods' && MOD_PLUGIN_EXTS.has(ext))) { skipped++; continue; }
            if (!Buffer.isBuffer(f.data)) { skipped++; continue; }

            const key = kind + '/' + name;
            let g = groups.get(key);
            if (!g) {
                g = { kind, name, files: [] };
                groups.set(key, g);
            }
            g.files.push({ rel, data: f.data });
        }

        return { groups, skipped };
    }

    /** 按 manifest.id 找出现有插件目录（目录名可能与 id 不一致） */
    async function findModDirsById(id) {
        const out = [];
        const entries = await readdir(modsDir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
            if (!e.isDirectory() || !isSafeModDirName(e.name)) continue;
            const dir = path.join(modsDir, e.name);
            const got = await readManifestId(path.join(dir, 'manifest.json'));
            if (got === id) out.push(dir);
        }
        return out;
    }

    /** 把一个分组写进临时目录，校验后再替换目标目录 */
    async function restoreOne(group) {
        const rootDir = group.kind === 'mods' ? modsDir : skillsDir;
        const target = path.join(rootDir, group.name);
        const staging = path.join(rootDir, STAGING_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));

        try {
            await mkdir(rootDir, { recursive: true });
            await mkdir(staging, { recursive: true });
            let bytes = 0;
            for (const f of group.files) {
                const out = path.join(staging, f.rel);
                // 双保险：拼出来的路径必须仍在临时目录内
                if (out !== staging && !out.startsWith(staging + path.sep)) {
                    throw new Error('条目路径越界：' + f.rel);
                }
                await mkdir(path.dirname(out), { recursive: true });
                await writeFile(out, f.data);
                bytes += f.data.length;
            }

            if (group.kind === 'skills') {
                const md = await stat(path.join(staging, 'SKILL.md')).catch(() => null);
                if (!md || !md.isFile()) throw new Error('技能备份里没有 SKILL.md');
                await rm(target, { recursive: true, force: true });
            } else {
                const incomingId = (await readManifestId(path.join(staging, 'manifest.json'))) || group.name;
                // 同一个 id 可能装在别的版本目录里（目录名只是安装时的包名）。
                // 先清掉同 id 的旧目录，避免导入后出现两个身份相同的插件。
                for (const dir of await findModDirsById(incomingId)) {
                    if (path.resolve(dir) === path.resolve(target)) continue;
                    await rm(dir, { recursive: true, force: true });
                }
                if (await exists(target)) {
                    const existingId = await readManifestId(path.join(target, 'manifest.json'));
                    if (existingId && existingId !== incomingId) {
                        throw new Error('目录 ' + group.name + ' 已被插件 ' + existingId + ' 占用');
                    }
                    await rm(target, { recursive: true, force: true });
                }
            }

            await rename(staging, target);
            return { files: group.files.length, bytes };
        } catch (err) {
            await rm(staging, { recursive: true, force: true }).catch(() => {});
            throw err;
        }
    }

    /**
     * 从备份 zip 的条目写回插件与技能。
     *
     * 按**包**替换：同名目录先删后写（写入前先落到临时目录），这样升级/降级
     * 都不会留下上一次版本多出来的文件。单个包失败只记在 errors 里，不影响
     * 其它包与数据导入 —— 一个坏插件不该让整份备份报废。
     *
     * @param {Array<{name:string,data:Buffer}>} files readZip 的输出
     * @param {{ allowScripts?: boolean, dryRun?: boolean }} [options]
     *   allowScripts：是否放行 .js/.html 等安装接口白名单里的"危险类型"。
     *   恢复插件必须开（入口就是 .js）；**只在纯恢复路径上开**，
     *   绝不能把这个口子开给任意解压（见 serve.mjs 的两处调用）。
     *   dryRun：只分组计数、不碰磁盘 —— 调用方据此判断"这个包里有没有
     *   值得恢复的插件 / 技能"，再决定是报成功还是"没有可导入的数据"。
     */
    async function restore(files, options = {}) {
        const { groups, skipped } = groupEntries(files || [], options.allowScripts === true);

        if (options.dryRun === true) {
            let mods = 0;
            let skills = 0;
            for (const g of groups.values()) {
                if (g.kind === 'mods') mods++;
                else skills++;
            }
            return { mods, skills, files: 0, skipped, errors: [], dryRun: true };
        }

        await cleanStaleStaging(modsDir);
        await cleanStaleStaging(skillsDir);

        let mods = 0;
        let skills = 0;
        let restoredFiles = 0;
        const errors = [];

        for (const group of groups.values()) {
            try {
                const r = await restoreOne(group);
                restoredFiles += r.files;
                if (group.kind === 'mods') mods++;
                else skills++;
                log('已从备份恢复' + (group.kind === 'mods' ? '插件 ' : '技能 ') + group.name + '（' + r.files + ' 个文件）');
            } catch (err) {
                const msg = String((err && err.message) || err);
                errors.push(group.kind + '/' + group.name + '：' + msg);
                log('恢复失败 ' + group.kind + '/' + group.name + '：' + msg);
            }
        }

        return { mods, skills, files: restoredFiles, skipped, errors };
    }

    return { collect, counts, restore };
}
