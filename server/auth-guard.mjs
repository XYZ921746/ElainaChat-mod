// 登录防爆破 —— 失败计数、指数退避、全局限流。密码从"聊天室的钥匙"变成了"整台电脑的钥匙"（局域网可执行命令），所以防爆破是必需项而不是加分项。
// 固定窗口（"5 次 / 锁 60 秒"）等于告诉攻击者"每 60 秒可以试 5 次"，保持低频就能无限试；只按 IP 锁也挡不住换 IP 的爆破（局域网里 DHCP 续租就能换），所以还有一道全局限流：所有来源的失败汇总计数，超阈值临时冻结全部登录。
// 计数只在成功时清零（锁定到期不重置）：否则攻击者每轮都能拿满机会，指数退避形同虚设；配合每次校验都走 scrypt 的固有成本，8 位以上的密码才真正安全。

/** 密码最短长度。6 位在离线爆破下是秒级，配合"局域网可执行命令"不可接受。 */
export const PWD_MIN_LEN = 8;

export const PWD_MAX_LEN = 128;

/** 极常见弱口令：不追求穷尽字典（那是离线爆破的事），只挡住"用户图省事直接敲的"那几条 —— 它们占了真实弱密码的绝大多数。 */
const WEAK_PASSWORDS = new Set([
    'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd',
    '12345678', '123456789', '1234567890', '87654321',
    'qwerty123', 'qwertyui', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm1',
    'abc12345', 'abcd1234', 'a1234567', 'admin123', 'administrator1',
    'letmein1', 'iloveyou1', 'welcome1', 'monkey123', 'dragon123',
    'elaina123', 'elainachat1', 'sunshine1', 'princess1', 'football1',
]);

const SEQUENCES = [
    '0123456789', '9876543210',
    'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
    'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz',
];

function weakPasswordMessage(lower) {
    if (WEAK_PASSWORDS.has(lower)) {
        return '这个密码太常见了，很容易被猜到，请换一个';
    }
    // 弱口令 + 少量后缀/前缀（admin123a、password1x 这类"加个尾巴"的写法）也要拦：多一个字符就放行，而它在任何字典攻击里都是第一梯队
    for (const w of WEAK_PASSWORDS) {
        if (w.length < 6) continue;
        if (lower.startsWith(w) && lower.length - w.length <= 2) {
            return '这个密码是在常见弱口令后面加了几位，很容易被猜到，请换一个';
        }
        if (lower.endsWith(w) && lower.length - w.length <= 2) {
            return '这个密码是在常见弱口令前面加了几位，很容易被猜到，请换一个';
        }
    }
    return null;
}

/** 校验新密码强度：至少 8 位，且同时含数字、小写字母、大写字母；在此之上再挡几条最常见的敷衍写法（纯重复字符、纯顺子/键盘序）与极常见弱口令表。
 * 刻意不强制特殊字符：那会把人逼去写 Password1! 这类可预测的形态，收益低于"更长 + 三类字符"本身。@returns {{ok:true} | {ok:false, message:string}} */
export function validatePasswordStrength(pwd) {
    const s = String(pwd == null ? '' : pwd);
    if (s.length < PWD_MIN_LEN) return { ok: false, message: `新密码至少 ${PWD_MIN_LEN} 位` };
    if (s.length > PWD_MAX_LEN) return { ok: false, message: '新密码过长' };

    const missing = [];
    if (!/[0-9]/.test(s)) missing.push('数字');
    if (!/[a-z]/.test(s)) missing.push('小写字母');
    if (!/[A-Z]/.test(s)) missing.push('大写字母');
    if (missing.length) {
        return { ok: false, message: `新密码必须同时包含${missing.join('、')}（当前缺${missing.join('、')}）` };
    }

    const lower = s.toLowerCase();
    const weak = weakPasswordMessage(lower);
    if (weak) return { ok: false, message: weak };
    // 短模式重复（Ab1Ab1Ab1、abcabcabc 这类）；单字符重复（aaaaaaaa）到不了这里 —— 它已因"缺数字/大写"被上面挡掉
    if (/^(.{1,4})\1+$/.test(s)) {
        return { ok: false, message: '新密码是同一段内容重复，请换一个' };
    }
    // 字符种类太少（Aaa1aaaa：只有 a/A/1 三种，熵极低但字面满足"三类字符"）：上面所有规则都拦不住它，而它的实际强度远低于 8 位随机 —— 要求 4 种不同字符是个便宜的兜底
    const distinct = new Set(s).size;
    if (distinct < 4) {
        return { ok: false, message: '新密码用到的字符太少了（至少要用 4 种不同字符），请换一个' };
    }
    // 顺子 / 键盘序：按"最长连续段 + 剩余长度"判，而不是"是否包含某个 6 连" —— 后者会把 xKp123456zQ 这种正常密码也误杀
    const longest = longestSequentialRun(lower);
    if (longest >= 6 && s.length - longest <= 2) {
        return { ok: false, message: '新密码里几乎全是连续顺序（如 12345678、qwertyui），请换一个' };
    }
    return { ok: true };
}

function longestSequentialRun(lower) {
    let best = 0;
    for (const seq of SEQUENCES) {
        for (let start = 0; start < seq.length; start++) {
            for (let len = Math.max(6, best + 1); start + len <= seq.length; len++) {
                if (lower.includes(seq.slice(start, start + len))) {
                    if (len > best) best = len;
                } else {
                    break; // 该起点再长也不会命中
                }
            }
        }
    }
    return best;
}

/** 创建一个登录守卫：时钟与全部阈值都可注入 —— 测试里把 now 换成手动推进的函数，就能在毫秒内断言"连续失败 12 次后的锁定是 1 小时"；opts 含 maxFails / baseLockMs / maxLockMs / globalWindowMs / globalMaxFails / globalLockMs / pruneIdleMs / now */
export function createLoginGuard(opts = {}) {
    const cfg = {
        maxFails: opts.maxFails ?? 5,
        baseLockMs: opts.baseLockMs ?? 30_000,
        maxLockMs: opts.maxLockMs ?? 60 * 60 * 1000,
        globalWindowMs: opts.globalWindowMs ?? 10 * 60 * 1000,
        globalMaxFails: opts.globalMaxFails ?? 30,
        globalLockMs: opts.globalLockMs ?? 5 * 60 * 1000,
        pruneIdleMs: opts.pruneIdleMs ?? 24 * 60 * 60 * 1000,
        now: opts.now ?? (() => Date.now()),
    };

    const perIp = new Map();     // ip -> { count, lockUntil, last }（last = 最后一次失败的时间）
    let globalFails = [];        // 失败时间戳（滑动窗口）
    let globalLockUntil = 0;

    function pruneGlobal(now) {
        const cutoff = now - cfg.globalWindowMs;
        let i = 0;
        while (i < globalFails.length && globalFails[i] < cutoff) i++;
        if (i) globalFails = globalFails.slice(i);
    }

    /** 当前是否被拦。先看全局冻结（它连正常用户一起挡，所以优先报出来） */
    function status(ip) {
        const now = cfg.now();
        pruneGlobal(now);
        if (globalLockUntil > now) {
            return {
                blocked: true,
                scope: 'global',
                retryAfterSec: Math.ceil((globalLockUntil - now) / 1000),
            };
        }
        const rec = perIp.get(ip);
        if (rec && rec.lockUntil > now) {
            return {
                blocked: true,
                scope: 'ip',
                retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000),
            };
        }
        return { blocked: false, scope: null, retryAfterSec: 0 };
    }

    /** 记一次失败。count 只在成功时清零（见 succeed），锁定到期不重置计数 —— 否则攻击者每轮都能重新拿满 maxFails 次机会，指数退避白做。 */
    function fail(ip) {
        const now = cfg.now();
        pruneGlobal(now);
        const rec = perIp.get(ip) || { count: 0, lockUntil: 0, last: now };
        rec.count += 1;
        rec.last = now;
        if (rec.count >= cfg.maxFails) {
            const over = rec.count - cfg.maxFails;
            const lockMs = Math.min(cfg.baseLockMs * Math.pow(2, over), cfg.maxLockMs);
            rec.lockUntil = now + lockMs;
        }
        perIp.set(ip, rec);

        globalFails.push(now);
        if (globalFails.length >= cfg.globalMaxFails) {
            globalLockUntil = now + cfg.globalLockMs;
            globalFails = [];
            return { count: rec.count, lockMs: Math.max(0, rec.lockUntil - now), globalLocked: true };
        }
        return { count: rec.count, lockMs: Math.max(0, rec.lockUntil - now), globalLocked: false };
    }

    function succeed(ip) {
        perIp.delete(ip);
    }

    /**
     * 清掉已经不用再记的 IP 记录：perIp 只在该 IP 成功登录或整体 reset 时才删，而换源的扫描、DHCP 续租、浏览器的 IPv6 隐私地址会不断产生新键 —— 只增不减就是一条慢速内存泄漏。
     * 只删"锁定已过期且失败计数停在阈值以下"的记录（还欠着次数的记录保留，继续攻击照样越锁越久），返回清掉的条数。 */
    function prune(now = cfg.now()) {
        let removed = 0;
        for (const [ip, rec] of perIp) {
            if (rec.lockUntil > now) continue;              // 正在锁定，留着
            if (rec.count >= cfg.maxFails) continue;        // 已到阈值：再来一次就该锁定，别把账抹掉
            if (now - rec.last >= cfg.pruneIdleMs) { perIp.delete(ip); removed++; }
        }
        return removed;
    }

    /** 全清（改密码时用：旧密码的失败记录不该留给新密码） */
    function reset() {
        perIp.clear();
        globalFails = [];
        globalLockUntil = 0;
    }

    return { status, fail, succeed, reset, prune, _cfg: cfg, _perIp: perIp };
}

export const __test__ = { WEAK_PASSWORDS, SEQUENCES };
