// 内存日志缓冲 + 过滤查询（AstrBot 风格分级系统的服务端一半）：emitLog 写每条日志时顺手存进环形缓冲，/api/logs/tail 按级别/模块/关键词过滤后返回，前端日志查看器轮询它实现"在软件里筛着看"。
// 每条都收、不受落盘级别约束 —— 过滤发生在"读"的时候：写入时就按级别丢的话，调过落盘级别后 DEBUG 就永远回不来了。纯逻辑，不碰 console、不碰文件，便于单测。
const RING_CAPACITY = 3000;                // 内存里最多留多少条（约 1-2MB）

/** 级别 → 数值，用于比较过滤。与 serve.mjs 的 LEVEL_NO 保持一致。 */
export const LEVEL_NUM = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, CRITICAL: 50 };

export function createLogBuffer(capacity = RING_CAPACITY) {
    const ring = new Array(capacity);
    let head = 0;          // 下一个写入位置
    let size = 0;          // 当前条数
    let dropped = 0;       // 因缓冲满被挤掉的条数（只作统计）
    let seqCounter = 0;    // 单调递增的写入序号（增量游标用，见 push/query）

    /** 存一条。字段在写入时解析好，读取端零解析成本。e = { ts, level, tag, loc, message } */
    function push(e) {
        ring[head] = {
            ts: e.ts instanceof Date ? e.ts.getTime() : (e.ts || Date.now()),
            // seq：单调递增的写入序号，只用于增量游标 —— 时间戳会被同一毫秒内的多条记录共享，光靠它无法区分先后（见 query）
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
     * 按条件过滤，新→旧返回（查看器最新在上）。q：minLevel（含，如 'INFO' 表示 INFO 及以上）/ tags（空 = 全部）/ search（对 message，大小写不敏感）/ limit（默认 500）/ since（只返回 ts > since，轮询增量用）。
     * sinceSeq：上次已经带走的那条的序号，同毫秒内的新记录靠它精确排除（见下面 query 里的说明）。
     */
    function query(q = {}) {
        const min = LEVEL_NUM[q.minLevel] ?? 0;
        const tags = Array.isArray(q.tags) && q.tags.length ? new Set(q.tags) : null;
        const search = q.search ? String(q.search).toLowerCase() : '';
        const limit = Math.min(Number(q.limit) || 500, capacity);
        const since = Number(q.since) || 0;
        // 游标：上次已经带走的那条的序号，同毫秒内的新记录靠它区分。没传 seq 时不启用精确模式（保持严格的 ">" 语义）—— 老调用方只传 since，精确模式会把"同毫秒、但已经给过它"的记录再返回一次，在它那边表现为重复行。
        const hasSeqCursor = Number.isInteger(Number(q.sinceSeq)) && q.sinceSeq !== null && q.sinceSeq !== undefined;
        const sinceSeq = hasSeqCursor ? Number(q.sinceSeq) : -1;

        const out = [];
        // 从最新的往回扫（head 的前一个就是最新写入的）
        for (let i = 0; i < size && out.length < limit; i++) {
            const idx = (head - 1 - i + capacity * 2) % capacity;
            const e = ring[idx];
            if (!e) continue;
            // 增量游标必须比到序号，不能只比时间戳：一次启动会连打十几条日志，同一毫秒里完全可能有 5 条 —— 用闭区间比 ts 会把"晚于它写入的同毫秒记录"跳过，而且下一轮的 lastTs 还是这个毫秒，它们永远补不回来（表现为"面板刷过好几行，查看器里少几行"）。
            // 给了 sinceSeq → 同毫秒内按序号精确排除，不丢也不重；只给 since → 保持严格 ">"，宁可重复也不改变旧语义。
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
