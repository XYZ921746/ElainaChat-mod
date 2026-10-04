// 内存日志缓冲 + 过滤查询（AstrBot 风格分级系统的服务端一半）。
//
// ── 这是什么 ────────────────────────────────────────────────────────────
//
// 用户的目标：**控制台输出全部日志；软件内日志查看器能按级别/模块过滤，
// 分离掉不想看的信息** —— 即 AstrBot 那种"终端全量、界面筛着看"的体验。
//
// 之前没做成的部分：软件内只有一个"改落盘级别"的下拉框，没有"看日志"的地方；
// 想看日志得去翻文件或盯 cmd 窗口（手机上根本没有）。
//
// 这一半的职责：
//   · emitLog 写每条日志时，顺手存进一个**环形缓冲**（有上限，不撑爆内存）
//   · /api/logs/tail 按级别/模块/关键词过滤后返回
//   · 前端日志查看器轮询它，实现"在软件里筛着看"
//
// ── 设计决定 ────────────────────────────────────────────────────────────
//
//   · **每条都收，不受落盘级别约束**。过滤发生在"读"的时候，不发生在"写"。
//     这样用户把查看器切到 DEBUG 能看到全量（等同终端），切到 ERROR 只看报错；
//     若写入时就按级别丢，调过落盘级别后 DEBUG 就永远回不来了。
//   · 模块名（tag）与级别在**写入时解析一次**，读取时就是现成字段，
//     过滤不需要正则跑全文。
//   · 环形缓冲用数组 + 指针实现（不 splice），push 是 O(1)。
//
// 本模块**纯逻辑**：不碰 console、不碰文件，便于单测。
const RING_CAPACITY = 3000;                // 内存里最多留多少条（约 1-2MB）

/** 级别 → 数值，用于比较过滤。与 serve.mjs 的 LEVEL_NO 保持一致。 */
export const LEVEL_NUM = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };

export function createLogBuffer(capacity = RING_CAPACITY) {
    const ring = new Array(capacity);
    let head = 0;          // 下一个写入位置
    let size = 0;          // 当前条数
    let dropped = 0;       // 因缓冲满被挤掉的条数（只作统计）
    let seqCounter = 0;    // 单调递增的写入序号（增量游标用，见 push/query）

    /**
     * 存一条。字段在写入时解析好，读取端零解析成本。
     *
     * @param {object} e { ts, level, tag, loc, message }
     */
    function push(e) {
        ring[head] = {
            ts: e.ts instanceof Date ? e.ts.getTime() : (e.ts || Date.now()),
            // seq：单调递增的写入序号，**只用于增量游标**。
            // 时间戳会被同一毫秒内多条记录共享，光靠它无法区分先后（见 query 里的说明）；
            // 序号不会重复，所以"上次带到哪一条"可以精确定位。
            seq: seqCounter++,
            level: e.level || 'INFO',
            tag: e.tag || 'Core',
            loc: e.loc || '',
            message: String(e.message ?? ''),
        };
        head = (head + 1) % capacity;
        if (size < capacity) size++;
        else dropped++;
    }

    /**
     * 按条件过滤，**新→旧**返回（查看器最新在上）。
     *
     * @param {object} [q]
     * @param {string} [q.minLevel] 最低级别（含），如 'INFO' → 返回 INFO 及以上
     * @param {string[]} [q.tags]   只看这些模块（空/缺省 = 全部）
     * @param {string}   [q.search] 关键词（大小写不敏感，对 message 匹配）
     * @param {number}   [q.limit]  最多返回多少条（默认 500）
     * @param {number}   [q.since]  只返回 ts > since 的（轮询增量拉取用）。
     *       同毫秒的记录靠 q.sinceSeq/q.seq 精确排除 —— 见下面 query 里的说明。
     */
    function query(q = {}) {
        const min = LEVEL_NUM[q.minLevel] ?? 0;
        const tags = Array.isArray(q.tags) && q.tags.length ? new Set(q.tags) : null;
        const search = q.search ? String(q.search).toLowerCase() : '';
        const limit = Math.min(Number(q.limit) || 500, capacity);
        const since = Number(q.since) || 0;
        // 游标：上次已经带走的那条的序号。同毫秒内的新记录靠它区分。
        // ★ 没传 seq 时**不启用精确模式**（保持旧的严格 ">" 语义）——
        //   老调用方只传 since，精确模式会把"同毫秒、但已经给过它"的记录再返回一次，
        //   在它那边表现为重复行。精度是**可选**的：要精确就给 sinceSeq。
        const hasSeqCursor = Number.isInteger(Number(q.sinceSeq)) && q.sinceSeq !== null && q.sinceSeq !== undefined;
        const sinceSeq = hasSeqCursor ? Number(q.sinceSeq) : -1;

        const out = [];
        // 从最新的往回扫（head 的前一个就是最新写入的）
        for (let i = 0; i < size && out.length < limit; i++) {
            const idx = (head - 1 - i + capacity * 2) % capacity;
            const e = ring[idx];
            if (!e) continue;
            // ★ 增量游标必须比到**序号**，不能只比时间戳（2026-10 修的真漏洞）。
            //
            //   时间戳只有毫秒精度，而一次启动会连打十几条日志 —— 同一个毫秒里
            //   完全可能有 5 条。旧实现是 `if (since && e.ts <= since) break;`
            //   （闭区间），于是查看器带着"这一毫秒最后一条"的 ts 回来时，
            //   同一毫秒里**晚于它写入的那些**会被判定为"不比 since 新"而跳过；
            //   更糟的是下一轮增量拿到的 lastTs 还是这个毫秒，它们**永远补不回来**。
            //   表现就是"bat 面板刷过好几行，查看器里少几行"。
            //
            //   两种模式：
            //     · 给了 sinceSeq（查看器用的）→ 同毫秒内按序号精确排除，不丢也不重
            //     · 只给 since（老调用方）  → 保持严格 ">"，宁可重复也不改变旧语义
            if (since) {
                if (e.ts < since) break;                        // 再往前都更旧，可以停
                if (e.ts === since) {
                    if (!hasSeqCursor) continue;                // 旧语义：同毫秒一律算旧
                    if (e.seq <= sinceSeq) continue;            // 精确语义：只排除已带走的
                }
            }
            if ((LEVEL_NUM[e.level] ?? 20) < min) continue;
            if (tags && !tags.has(e.tag)) continue;
            if (search && !e.message.toLowerCase().includes(search)) continue;
            out.push(e);
        }
        return { entries: out, total: size, dropped };
    }

    /** 当前缓冲里出现过的模块名（给前端做过滤下拉框） */
    function tags() {
        const s = new Set();
        for (let i = 0; i < size; i++) {
            const e = ring[(head - 1 - i + capacity * 2) % capacity];
            if (e) s.add(e.tag);
        }
        return [...s].sort();
    }

    function stats() {
        return { capacity, size, dropped };
    }

    return { push, query, tags, stats };
}
