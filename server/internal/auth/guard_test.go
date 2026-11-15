package auth

import (
	"testing"
	"time"
)

func TestGuardLockAndBackoff(t *testing.T) {
	g := NewGuard()
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	ip := "192.0.2.10"
	for i := 0; i < 5; i++ {
		g.Fail(ip)
	}
	st := g.Status(ip)
	if !st.Blocked || st.Scope != "ip" {
		t.Fatalf("连续 5 次失败后应锁定该 IP，实际：%+v", st)
	}
	if st.RetryAfterSec <= 0 || st.RetryAfterSec > 30 {
		t.Fatalf("首次锁定时长应为 30 秒，实际：%d", st.RetryAfterSec)
	}

	now = now.Add(31 * time.Second)
	if g.Status(ip).Blocked {
		t.Fatal("锁定到期后应放行")
	}
	// 计数只在成功登录时清零：到期后再失败一次应直接进入更长的锁定。
	g.Fail(ip)
	st = g.Status(ip)
	if !st.Blocked || st.RetryAfterSec <= 30 {
		t.Fatalf("第二次锁定应长于 30 秒，实际：%+v", st)
	}

	g.Succeed(ip)
	if g.Status(ip).Blocked {
		t.Fatal("成功登录后应解除锁定")
	}
}

func TestGuardGlobalFreeze(t *testing.T) {
	g := NewGuard()
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	// 不同来源各失败一次，累计到阈值后应冻结全部登录：
	// 只按 IP 锁挡不住换 IP 的爆破，全局那一层就是为此存在的。
	for i := 0; i < 30; i++ {
		g.Fail("198.51.100." + itoa(i))
	}
	st := g.Status("203.0.113.1")
	if !st.Blocked || st.Scope != "global" {
		t.Fatalf("累计失败应触发全局冻结，实际：%+v", st)
	}
	if st.RetryAfterSec <= 0 {
		t.Fatal("全局冻结必须给出等待秒数")
	}
}

func TestGuardPruneKeepsAccounts(t *testing.T) {
	g := NewGuard()
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	g.Fail("192.0.2.20")
	now = now.Add(25 * time.Hour)
	if removed := g.Prune(); removed != 1 {
		t.Fatalf("空闲超过 24 小时且未到阈值的记录应被清理，实际清理 %d 条", removed)
	}

	// 已到阈值的记录必须保留：抹掉等于让攻击者重新拿满机会。
	for i := 0; i < 5; i++ {
		g.Fail("192.0.2.21")
	}
	now = now.Add(25 * time.Hour)
	if removed := g.Prune(); removed != 0 {
		t.Fatalf("已到阈值的记录不应被清理，实际清理 %d 条", removed)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
