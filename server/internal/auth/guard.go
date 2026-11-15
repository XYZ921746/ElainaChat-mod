package auth

import (
	"math"
	"sync"
	"time"
)

// Guard 是登录防爆破。密码从「聊天室的钥匙」变成了「整台电脑的钥匙」，
// 固定窗口（如 5 次 / 60 秒）等于告诉攻击者每 60 秒可以试 5 次；
// 只按 IP 锁也挡不住换 IP 的爆破，所以还有一道按时间窗口汇总的全局限流。
// 计数只在成功时清零：锁定到期就重置的话，每轮都能拿满机会，指数退避形同虚设。
type Guard struct {
	mu sync.Mutex

	maxFails       int
	baseLock       time.Duration
	maxLock        time.Duration
	globalWindow   time.Duration
	globalMaxFails int
	globalLock     time.Duration
	pruneIdle      time.Duration
	now            func() time.Time

	perIP     map[string]ipRecord
	global    []time.Time
	globalEnd time.Time
}

type ipRecord struct {
	count   int
	lockEnd time.Time
	last    time.Time
}

// GuardStatus 是「当前是否被拦」的结果；全局冻结优先报出来，因为它连正常用户一起挡。
type GuardStatus struct {
	Blocked       bool
	Scope         string
	RetryAfterSec int
}

type FailResult struct {
	Count        int
	LockMs       int64
	GlobalLocked bool
}

func NewGuard() *Guard {
	return &Guard{
		maxFails:       5,
		baseLock:       30 * time.Second,
		maxLock:        60 * time.Minute,
		globalWindow:   10 * time.Minute,
		globalMaxFails: 30,
		globalLock:     5 * time.Minute,
		pruneIdle:      24 * time.Hour,
		now:            time.Now,
		perIP:          make(map[string]ipRecord),
	}
}

func (g *Guard) Status(ip string) GuardStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.pruneGlobalLocked(now)
	if now.Before(g.globalEnd) {
		return GuardStatus{Blocked: true, Scope: "global", RetryAfterSec: ceilSeconds(g.globalEnd.Sub(now))}
	}
	if rec, ok := g.perIP[ip]; ok && now.Before(rec.lockEnd) {
		return GuardStatus{Blocked: true, Scope: "ip", RetryAfterSec: ceilSeconds(rec.lockEnd.Sub(now))}
	}
	return GuardStatus{}
}

func (g *Guard) Fail(ip string) FailResult {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.pruneGlobalLocked(now)

	rec := g.perIP[ip]
	if rec.count == 0 {
		rec.last = now
	}
	rec.count++
	rec.last = now
	if rec.count >= g.maxFails {
		over := rec.count - g.maxFails
		lock := time.Duration(float64(g.baseLock) * math.Pow(2, float64(over)))
		if lock > g.maxLock {
			lock = g.maxLock
		}
		rec.lockEnd = now.Add(lock)
	}
	g.perIP[ip] = rec

	g.global = append(g.global, now)
	if len(g.global) >= g.globalMaxFails {
		g.globalEnd = now.Add(g.globalLock)
		g.global = nil
		return FailResult{Count: rec.count, LockMs: maxMillis(rec.lockEnd.Sub(now)), GlobalLocked: true}
	}
	return FailResult{Count: rec.count, LockMs: maxMillis(rec.lockEnd.Sub(now))}
}

func (g *Guard) Succeed(ip string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.perIP, ip)
}

// Reset 在改密码时清空：旧密码攒下的锁定不该连累新密码，
// 否则用户刚设完强密码，手机仍被锁着。
func (g *Guard) Reset() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.perIP = make(map[string]ipRecord)
	g.global = nil
	g.globalEnd = time.Time{}
}

// Prune 只删「锁定已过期且失败计数停在阈值以下」的记录：
// 还欠着次数的记录必须保留，否则再来一次就该锁定的账被抹掉了。
func (g *Guard) Prune() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	removed := 0
	for ip, rec := range g.perIP {
		if rec.lockEnd.After(now) || rec.count >= g.maxFails {
			continue
		}
		if now.Sub(rec.last) >= g.pruneIdle {
			delete(g.perIP, ip)
			removed++
		}
	}
	return removed
}

func (g *Guard) pruneGlobalLocked(now time.Time) {
	cutoff := now.Add(-g.globalWindow)
	i := 0
	for i < len(g.global) && g.global[i].Before(cutoff) {
		i++
	}
	if i > 0 {
		g.global = g.global[i:]
	}
}

func ceilSeconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	return int(math.Ceil(d.Seconds()))
}

func maxMillis(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	return d.Milliseconds()
}
