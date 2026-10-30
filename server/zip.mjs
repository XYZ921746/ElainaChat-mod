//  ZIP 读写（零依赖，只用 Node 内置 zlib）
//  为什么要自己写：备份导出需要打包成标准 zip（用户能用任何解压工具打开、
//  也方便一次拖进来看全部数据）。引第三方 zip 库会破坏"零依赖、双击即用"这个前提，
//  而 zip 的格式足够简单 —— 写一个只有几百行，读一个已有的实现（模型上传用的）也在。
//  写：deflateRawSync + crc32（都是 node:zlib 内置）
//  读：完整解析中央目录（zip 的权威元数据），兼容 GBK 文件名
//  标准兼容性：生成的是最保守的 zip ——
//    · 只用 deflate(8) 与 store(0) 两种方法
//    · 文件名统一 UTF-8，并置 bit 11（EFS）标志，让 Windows 资源管理器正确显示中文
//    · 不写 data descriptor（长度在 local header 里直接给出）
//    · 不写 zip64（备份超过 4GB 才需要，数据目录远达不到）
//  这样 7-Zip / WinRAR / Windows 自带解压 / Python zipfile 都能正确打开。

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';

/**
 * CRC-32（IEEE 802.3，zip 用的那个）。
 *
 * <p>★ 为什么不 from 'node:zlib' import：{@code zlib.crc32} 是 **Node 20.15+**
 * 才加的 API，而手机端内嵌的是 nodejs-mobile **v18.20.4** —— 从 zlib 解构它会在
 * 模块求值阶段就抛 {@code SyntaxError: The requested module 'node:zlib' does not
 * provide an export named 'crc32'}，整个 bootstrap 起不来（表现是 :node 进程
 * 起来后 250ms 静默退出）。这个模块是零依赖设计，自己算一遍最稳，也不挑运行时版本。
 */
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

//  危险扩展名（解压落盘的安全底线）
//  这份清单原来在 web/serve.mjs 里。合并解压实现时一起搬到这里 ——
//  它属于"解压"这件事的安全约束，跟着实现走才能保证所有调用方都受保护。
//  serve.mjs 仍然从这里 import 使用（agentWrite 也要用它）。
export const BLOCKED_EXT = new Set([
    '.html', '.htm', '.xhtml', '.shtml', '.hta', '.mhtml',
    '.js', '.mjs', '.cjs', '.jsx', '.ts',
    '.svg', '.xml', '.xsl',
    '.exe', '.dll', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.wsf', '.jar', '.sh',
]);

/**
 * 插件安装时**允许**落盘的危险扩展名（`allowScripts: true` 才生效）。
 *
 * 为什么插件要单独一组而不是"整份黑名单都不查"：插件确实需要 .js（它的本质
 * 就是 JS）和 .html（有些插件带自己的面板页，例如 live2d 的 panel.html），
 * 但**不需要** .exe / .dll / .bat 这类本机可执行文件 —— 那些对插件毫无用途，
 * 落盘只会在用户误双击时变成风险。
 *
 * 所以这一组是**白名单语义**：只放行"插件真的会用到的危险类型"，
 * 其余危险类型在插件安装路径上照样拦。
 */
export const PLUGIN_EXTS = new Set([
    '.js', '.mjs', '.cjs', '.jsx', '.ts',
    '.html', '.htm',
]);

/**
 * 取「最终落盘名」的扩展名。
 *
 * 为什么不能直接用 path.extname：Windows 上有三种写法，extname 看到的和真正落盘的
 * **不是同一个名字**，于是黑名单被绕过（实测均可复现）：
 *
 *   x.html::$DATA   → extname 得到 ".html::$data"，但 NTFS 交换数据流语法下
 *                     写它等于写默认流，**落盘就是 x.html**，静态服务照样当 HTML 执行
 *   x.html.         → extname 得到 "."，Windows 会丢掉尾随点，落盘仍是 x.html
 *   x.html␠        → extname 得到 ".html "，尾随空格同样被丢掉
 *
 * 所以先把这些"看不见的尾巴"剥干净，再取扩展名。
 */
export function effectiveExt(name) {
    let s = String(name == null ? '' : name);
    const colon = s.indexOf(':');          // NTFS ADS：只保留流名之前的部分
    if (colon >= 0) s = s.slice(0, colon);
    s = s.replace(/[. ]+$/, '');           // Windows 会丢弃尾随的点与空格
    return path.extname(s).toLowerCase();
}

/**
 * 条目名是否不安全（绝对路径 / 路径穿越）。
 *
 * 从这里导出给所有"解压落盘"的调用方（含 serve.mjs 与手机端 bootstrap 的
 * hostUtils）。理由与 BLOCKED_EXT 相同：它属于"解压/落盘"的安全约束，跟着
 * 实现走才能保证所有调用方受同一份判定 —— 各留一份本地实现的话，"同一个
 * 恶意 zip 在电脑被拦、在手机落盘"这种分叉只是时间问题。
 */
export function isUnsafeEntryName(name) {
    if (!name) return true;
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return true;
    // 反斜杠也要按分隔符算：解压实现会先归一，但这里是"所有落盘调用方共用"的判据 ——
    //   谁漏了一次归一，`..\\x` 在 Windows 上就是一次真实的路径穿越。
    return name.split(/[\\/]+/).some((seg) => seg === '..');
}

/**
 * 上传的压缩包大小上限（200MB）。
 *
 * 从这里导出：所有调用方（桌面 serve.mjs、手机端 bootstrap 的
 * hostUtils、插件的 ctx.utils.MAX_UPLOAD）必须吃**同一个数** —— 数字一旦
 * 分叉就是"同一个接口在电脑上能传、在手机上 413"，这类问题最难查。
 * 单文件 / 总量上限（maxEntry/maxTotal）不导出：那是 readZip 的参数默认值，
 * 已在本模块内。
 */
export const MAX_UPLOAD = 200 * 1024 * 1024;

// ---------------------------------------------------------------------- 写
/**
 * 打包成 zip。
 * @param entries [{ name: 'a/b.json', data: Buffer|string }]
 * @returns Buffer
 */
export function createZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const name = String(entry.name || '').replace(/\\/g, '/');
        if (!name || name.endsWith('/')) continue;   // 空名与目录项跳过
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
        const nameBuf = Buffer.from(name, 'utf8');

        // 小文件压缩收益有限；大文件才值得 deflate
        const useDeflate = raw.length > 256;
        const compressed = useDeflate ? deflateRawSync(raw, { level: 6 }) : raw;
        const method = useDeflate ? 8 : 0;
        // 压缩后反而更大就退回 store
        const finalData = (useDeflate && compressed.length >= raw.length) ? raw : compressed;
        const finalMethod = (useDeflate && compressed.length >= raw.length) ? 0 : method;

        const crc = crc32(raw) >>> 0;
        const size = raw.length;
        const compSize = finalData.length;

        // ---- local file header (30 字节 + 文件名) ----
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);        // 签名
        local.writeUInt16LE(20, 4);                // 需要版本 2.0
        local.writeUInt16LE(0x0800, 6);            // flags: bit 11 = UTF-8 文件名
        local.writeUInt16LE(finalMethod, 8);       // 压缩方法
        local.writeUInt16LE(0, 10);                // 修改时间（用固定值，保证同数据产出同字节）
        local.writeUInt16LE(0x21, 12);             // 修改日期（1980-01-01）
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compSize, 18);
        local.writeUInt32LE(size, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);                // extra 长度
        localParts.push(local, nameBuf, finalData);

        // ---- central directory header (46 字节 + 文件名) ----
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);      // 签名
        central.writeUInt16LE(20, 4);              // 创建版本
        central.writeUInt16LE(20, 6);              // 需要版本
        central.writeUInt16LE(0x0800, 8);          // flags
        central.writeUInt16LE(finalMethod, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0x21, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compSize, 20);
        central.writeUInt32LE(size, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);              // extra
        central.writeUInt16LE(0, 32);              // comment
        central.writeUInt16LE(0, 34);              // 磁盘号
        central.writeUInt16LE(0, 36);              // 内部属性
        central.writeUInt32LE(0, 38);              // 外部属性
        central.writeUInt32LE(offset, 42);         // local header 偏移
        centralParts.push(central, nameBuf);

        offset += local.length + nameBuf.length + finalData.length;
    }

    const centralBuf = Buffer.concat(centralParts);
    const localBuf = Buffer.concat(localParts);

    // ---- end of central directory (22 字节) ----
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centralParts.length / 2, 8);   // 条目数（每项 2 个 buffer）
    eocd.writeUInt16LE(centralParts.length / 2, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);          // 中央目录起始偏移
    eocd.writeUInt16LE(0, 20);                        // 注释长度

    return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ---------------------------------------------------------------------- 读
/** 在 buffer 里找 EOCD（从尾部往前扫，最多 64KB 注释） */
function findEocd(buf) {
    const min = Math.max(0, buf.length - 22 - 0xFFFF);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
    }
    return -1;
}

/** GBK → UTF-8 的兜底解码（老工具打的 zip 文件名不是 UTF-8） */
function gbkDecode(buf) {
    // 用 TextDecoder 的 gbk 支持（Node 18+ 内置完整 ICU 时可用）
    try {
        return new TextDecoder('gbk').decode(buf);
    } catch {
        return buf.toString('utf8');
    }
}

/** 读中央目录（权威元数据）；EOCD 缺失/损坏时返回空表，让调用方回退到 local header。 */
function readCentralEntries(buf, decodeName) {
    const entries = [];
    let fromCentral = false;
    const eocdOff = findEocd(buf);
    if (eocdOff >= 0) {
        const total = buf.readUInt16LE(eocdOff + 10);
        const cdSize = buf.readUInt32LE(eocdOff + 12);
        const cdOff = buf.readUInt32LE(eocdOff + 16);
        const isZip64 = cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || total === 0xFFFF;
        if (!isZip64 && cdOff + cdSize <= buf.length) {
            let off = cdOff;
            let ok = true;
            for (let i = 0; i < total; i++) {
                if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) { ok = false; break; }
                const flags = buf.readUInt16LE(off + 8);
                const method = buf.readUInt16LE(off + 10);
                const compSize = buf.readUInt32LE(off + 20);
                const nameLen = buf.readUInt16LE(off + 28);
                const extraLen = buf.readUInt16LE(off + 30);
                const commentLen = buf.readUInt16LE(off + 32);
                const localOff = buf.readUInt32LE(off + 42);
                const nameRaw = buf.subarray(off + 46, off + 46 + nameLen);
                entries.push({ name: decodeName(nameRaw, flags), method, compSize, localOff });
                off += 46 + nameLen + extraLen + commentLen;
            }
            fromCentral = ok;
            if (!ok) entries.length = 0;
        }
    }
    return { entries, fromCentral };
}

/** 回退：没有可用中央目录时按 local header 顺序读（data descriptor 无法可靠定位，直接拒绝）。 */
function readLocalEntries(buf, decodeName) {
    const entries = [];
    let off = 0;
    while (off + 30 <= buf.length) {
        if (buf.readUInt32LE(off) !== 0x04034b50) break;
        const flags = buf.readUInt16LE(off + 6);
        const method = buf.readUInt16LE(off + 8);
        const compSize = buf.readUInt32LE(off + 18);
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const nameRaw = buf.subarray(off + 30, off + 30 + nameLen);
        if (flags & 0x8) throw new Error('该 zip 缺少中央目录且用了 data descriptor，无法可靠读取');
        entries.push({ name: decodeName(nameRaw, flags), method, compSize, localOff: off });
        off = off + 30 + nameLen + extraLen + compSize;
    }
    return entries;
}

/**
 * 取出一个条目的内容。local header 不合法时返回 null（调用方跳过该条）；
 * 体积超限 / 压缩方式不支持 / 解压失败都抛错 —— 这些是整包拒绝的理由。
 */
function extractEntryContent(buf, e, name, maxEntry, maxTotal, total) {
    if (e.localOff + 30 > buf.length || buf.readUInt32LE(e.localOff) !== 0x04034b50) return null;
    const lNameLen = buf.readUInt16LE(e.localOff + 26);
    const lExtraLen = buf.readUInt16LE(e.localOff + 28);
    const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + e.compSize);

    if (e.method !== 0 && e.method !== 8) throw new Error(`不支持的压缩方式 ${e.method}（${name}）`);
    if (e.compSize > maxEntry || total + e.compSize > maxTotal) {
        throw new Error('备份解压后体积超过上限，已拒绝');
    }
    if (e.method === 0) return Buffer.from(data);
    try {
        return inflateRawSync(data, { maxOutputLength: Math.min(maxEntry, maxTotal - total) });
    } catch (err) {
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || /too large/i.test(String(err.message)))) {
            throw new Error('备份解压后体积超过上限，已拒绝');
        }
        throw new Error(`条目解压失败：${name}（${err.message}）`);
    }
}

/**
 * 解压 zip。
 *
 * @param buf zip 内容
 * @param opts {
 *   maxTotal,       解压后总大小上限（防压缩炸弹）
 *   maxEntry,       单文件上限
 *   allowScripts,   是否允许 .js/.mjs 等脚本落盘（默认 false）
 *   blockExts,      额外要拦的扩展名集合（可选）
 *   returnBlocked,  true 时返回 { files, blocked }，否则只返回数组（兼容旧调用）
 * }
 * @returns [{ name, data }] 或 { files, blocked }
 *
 * ── 为什么危险类型拦截放在这里（而不是各调用方自己写）──────────────────
 *
 * 这个函数是**服务端唯一的 zip 解压实现**：两份几乎相同的 unzip 各存在时，
 * 安全修复必须改两处，漏一处就是个洞。危险扩展名拦截属于"解压这件事"的安全底线，
 * 放在实现内部才能保证每个调用方都受保护 —— 若只在某个调用方里拦，
 * 数据导入路径就成了绕过点（虽然导入的键名受白名单限制，风险低，但没必要留口子）。
 *
 * **默认拦脚本**是因为本函数的主要调用方是"导入用户备份"，而备份里不该有 .js。
 * 但 mod（插件）安装必须允许脚本（mod 的本质就是 JS），所以给了 allowScripts 开关。
 * 开了之后路径穿越/绝对路径/体积上限仍然全部拦截。
 */
export function readZip(buf, opts = {}) {
    const maxTotal = opts.maxTotal ?? 512 * 1024 * 1024;
    const maxEntry = opts.maxEntry ?? 256 * 1024 * 1024;
    const allowScripts = opts.allowScripts === true;
    const returnBlocked = opts.returnBlocked === true;
    const blockExts = opts.blockExts || BLOCKED_EXT;

    // 允许脚本时，只放行 PLUGIN_EXTS 那一组（脚本 + HTML 面板），其余危险类型照旧拦
    const isBlocked = (name) => {
        const ext = effectiveExt(path.posix.basename(name));
        if (allowScripts && PLUGIN_EXTS.has(ext)) return false;
        return blockExts.has(ext);
    };

    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip 文件');
    if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 zip 文件');

    const decodeName = (nameRaw, flags) => {
        if (flags & 0x800) return nameRaw.toString('utf8');       // EFS 标志：确定是 UTF-8
        const utf8 = nameRaw.toString('utf8');
        return utf8.includes('\uFFFD') ? gbkDecode(nameRaw) : utf8;
    };

    // 中央目录是权威元数据，优先用它；坏了再回退到 local header。
    const { entries: centralEntries, fromCentral } = readCentralEntries(buf, decodeName);
    const entries = fromCentral ? centralEntries : readLocalEntries(buf, decodeName);

    if (!entries.length) throw new Error('zip 内没有文件');

    const files = [];
    const blocked = [];
    let total = 0;
    for (const e of entries) {
        if (e.name.endsWith('/') || e.name.endsWith('\\')) continue;
        const name = e.name.replace(/\\/g, '/');
        // 路径穿越防护：备份文件也可能被人为改坏
        if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) continue;
        // 危险类型拦截（.html/.js/.svg/.exe…）。用 effectiveExt 而非 extname ——
        // 后者会被 x.html::$DATA 这类 Windows 写法绕过（落盘仍是 x.html）
        if (isBlocked(name)) { blocked.push(name); continue; }

        const content = extractEntryContent(buf, e, name, maxEntry, maxTotal, total);
        if (!content) continue;
        total += content.length;
        if (total > maxTotal) throw new Error('备份解压后总大小超过上限');
        files.push({ name, data: content });
    }
    if (!files.length) throw new Error('zip 内没有可用文件');
    // 两种返回形态：老调用方（数据导入）拿数组，需要知道"哪些被拦了"的调用方
    // （模型上传、mod 安装）拿 { files, blocked }
    return returnBlocked ? { files, blocked } : files;
}

