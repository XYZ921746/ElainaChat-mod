package auth

import (
	"testing"
	"time"
)

// 指数退避的完整序列：首次 30 秒、逐次翻倍、锁定到期不清零计数（清零等于每轮把满额机会
// 还给攻击者，退避形同虚设）、成功登录才归零、按 IP 隔离。
func TestGuardBackoffDoublingSequence(t *testing.T) {
	g := NewGuard()
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	ip := "192.0.2.10"
	for i := 1; i <= 4; i++ {
		g.Fail(ip)
		if st := g.Status(ip); st.Blocked {
			t.Fatalf("第 %d 次失败后不应锁定（阈值 5），实际 %+v", i, st)
		}
	}
	if st := g.Status("203.0.113.9"); st.Blocked {
		t.Fatal("其它来源不应受牵连（按 IP 隔离）")
	}

	g.Fail(ip) // 第 5 次
	if st := g.Status(ip); !st.Blocked || st.RetryAfterSec != 30 {
		t.Fatalf("第 5 次失败后应锁定 30 秒，实际 %+v", g.Status(ip))
	}

	now = now.Add(31 * time.Second) // 首次锁定到期
	if g.Status(ip).Blocked {
		t.Fatal("锁定到期后应放行（但计数保留）")
	}
	g.Fail(ip) // 第 6 次
	if st := g.Status(ip); !st.Blocked || st.RetryAfterSec != 60 {
		t.Fatalf("第二次锁定应翻倍到 60 秒，实际 %+v", g.Status(ip))
	}

	now = now.Add(61 * time.Second)
	g.Fail(ip) // 第 7 次
	if st := g.Status(ip); !st.Blocked || st.RetryAfterSec != 120 {
		t.Fatalf("第三次锁定应到 120 秒，实际 %+v", g.Status(ip))
	}

	now = now.Add(121 * time.Second)
	g.Fail(ip) // 第 8 次：若到期清零，这里只会锁 30 秒
	if st := g.Status(ip); !st.Blocked || st.RetryAfterSec != 240 {
		t.Fatalf("锁定到期不清零计数，第 8 次应锁 240 秒，实际 %+v", g.Status(ip))
	}

	g.Succeed(ip)
	if g.Status(ip).Blocked {
		t.Fatal("登录成功后应解锁")
	}
	for i := 0; i < 4; i++ {
		g.Fail(ip)
	}
	if g.Status(ip).Blocked {
		t.Fatal("成功清零后应重新从 0 计数（手滑的用户不会被越锁越久）")
	}
}

// 锁定时长必须封顶：不封顶的话，翻倍很快会到"几小时 / 几天"，把用户永久锁死。
func TestGuardLockCappedAtMax(t *testing.T) {
	g := NewGuard()
	g.maxFails = 2
	g.baseLock = 1 * time.Second
	g.maxLock = 8 * time.Second
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	capped := 0
	for i := 0; i < 20; i++ {
		g.Fail("192.0.2.30")
		capped = g.Status("192.0.2.30").RetryAfterSec
		now = now.Add(100 * time.Second)
	}
	if capped <= 0 || capped > 8 {
		t.Fatalf("锁定时长应封顶在 8 秒，实际 %d", capped)
	}
}

// 全局限流：换 IP 也挡得住 —— 各来源分散失败累计到阈值后冻结所有登录；
// 冻结连正常来源一起挡是全局限流固有的代价，到期必须恢复，reset（改密码）清空一切。
func TestGuardGlobalFreezeWindowAndReset(t *testing.T) {
	g := NewGuard()
	g.globalMaxFails = 10
	g.globalLock = 5 * time.Minute
	now := time.Unix(1_700_000_000, 0)
	g.now = func() time.Time { return now }

	for i := 0; i < 10; i++ {
		g.Fail("10.0.0." + itoa(i)) // 每个来源都没到自己 5 次的阈值
	}
	st := g.Status("10.0.0.99")
	if !st.Blocked || st.Scope != "global" || st.RetryAfterSec != 300 {
		t.Fatalf("分散失败应触发全局冻结 300 秒，实际 %+v", st)
	}
	if st := g.Status("192.168.1.50"); !st.Blocked {
		t.Fatal("冻结期间正常来源同样被挡（全局限流固有的代价）")
	}

	now = now.Add(301 * time.Second)
	if g.Status("192.168.1.50").Blocked {
		t.Fatal("全局冻结到期后应恢复")
	}

	g.Reset()
	if g.Status("10.0.0.1").Blocked {
		t.Fatal("reset 后所有锁定应被清空")
	}
}
