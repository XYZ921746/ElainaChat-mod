package security

import "testing"

// IsInternalAddress 的穷举表：中继发请求前用它挡 SSRF，漏一类写法就漏一个内网靶子。
// 表覆盖：回环与整段 127、RFC1918 三段、云元数据 169.254.169.254、未指定地址 0.0.0.0、
// IPv6 回环与全零、IPv4-mapped / IPv4-compatible 的 IPv6（点分与十六进制、带方括号）、
// 链路本地 fe80::/10 与唯一本地 fc00::/7 的首段；公网侧钉住 172.16-31 两端的边界，防误伤。
func TestIsInternalAddressSSRFTable(t *testing.T) {
	internal := []string{
		"127.0.0.1", "127.1.2.3",
		"10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
		"169.254.169.254", "0.0.0.0",
		"::1", "::",
		"::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:127.0.0.1]",
		"::ffff:192.168.1.1", "::ffff:10.0.0.1",
		"fe80::1", "fd00::1", "fc00::1",
	}
	for _, ip := range internal {
		if !IsInternalAddress(ip) {
			t.Errorf("IsInternalAddress(%q) 应判为内网", ip)
		}
	}

	external := []string{
		"8.8.8.8", "1.1.1.1",
		"172.32.0.1", "172.15.0.1", // 172.16-31 之外是公网，别误伤
		"11.0.0.1",
		"2001:4860:4860::8888", "::ffff:8.8.8.8",
	}
	for _, ip := range external {
		if IsInternalAddress(ip) {
			t.Errorf("IsInternalAddress(%q) 应判为公网", ip)
		}
	}
}

// 非规范写法的内网地址：字符串前缀判据认不出展开式 IPv6、带 zone 的链路本地，
// 也漏掉 CGNAT。这些写法连的都是内网，判定必须一致。
func TestIsInternalAddressNormalizedForms(t *testing.T) {
	internal := []string{
		"0:0:0:0:0:0:0:1",   // ::1 的展开写法
		"0:0:0:0:0:0:0:0",   // :: 的展开写法
		"[0:0:0:0:0:0:0:1]", // 带方括号
		"fe80::1%eth0",      // 带 zone 的链路本地
		"100.64.0.1",        // CGNAT 下界
		"100.127.255.255",   // CGNAT 上界
	}
	for _, ip := range internal {
		if !IsInternalAddress(ip) {
			t.Errorf("IsInternalAddress(%q) 应判为内网", ip)
		}
	}

	// CGNAT 之外仍是公网：100.63/100.128 不能被误伤。
	for _, ip := range []string{"100.63.255.255", "100.128.0.0", "8.8.8.8"} {
		if IsInternalAddress(ip) {
			t.Errorf("IsInternalAddress(%q) 应判为公网", ip)
		}
	}
	// 八进制/十六进制等非规范 IPv4 写法 netip 直接拒绝：判公网（保守）而不是放行。
	for _, ip := range []string{"0177.0.0.1", "0x7f.0.0.1"} {
		if IsInternalAddress(ip) {
			t.Errorf("IsInternalAddress(%q) 非规范写法应判公网（保守），不应放行", ip)
		}
	}
}

// MappedIPv4 是内网判定的规范化核心：只按字符串前缀比较的判据拿 "::ffff:127.0.0.1"
// 没有办法 —— 它连的就是回环，字符串却既不以 127. 开头也不是 ::1。
// 必须先还原成点分 IPv4 再进 RFC1918 / 回环判定。
func TestMappedIPv4Forms(t *testing.T) {
	cases := map[string]string{
		"::ffff:127.0.0.1":     "127.0.0.1",
		"::ffff:7f00:1":        "127.0.0.1",
		"[::ffff:127.0.0.1]":   "127.0.0.1",
		"::FFFF:192.168.1.1":   "192.168.1.1",
		"::ffff:10.0.0.1":      "10.0.0.1",
		"::ffff:8.8.8.8":       "8.8.8.8",
		"::1":                  "", // 不是 IPv4-mapped，还原不出 IPv4
		"fe80::1":              "",
		"2001:4860:4860::8888": "",
		"127.0.0.1":            "", // 没有 ':' 的地址不属于本函数管辖
		"":                     "",
	}
	for raw, want := range cases {
		if got := MappedIPv4(raw); got != want {
			t.Errorf("MappedIPv4(%q) = %q，应为 %q", raw, got, want)
		}
	}
}

// RFC1918 三段的上下边界与非法输入：判定松一段就把公网靶子放进内网，紧一段就误伤 legit 内网服务。
func TestIsPrivateIPv4Boundaries(t *testing.T) {
	cases := map[string]bool{
		"10.0.0.5":         true,
		"10.255.255.255":   true,
		"11.0.0.1":         false,
		"172.15.0.1":       false,
		"172.16.0.1":       true,
		"172.31.255.255":   true,
		"172.32.0.1":       false,
		"192.168.1.1":      true,
		"192.169.0.1":      false,
		"256.0.0.1":        false,
		"1.2.3":            false,
		"10.0.0.x":         false,
		"::ffff:127.0.0.1": false, // 只判点分 IPv4，映射形态归 MappedIPv4
	}
	for ip, want := range cases {
		if got := IsPrivateIPv4(ip); got != want {
			t.Errorf("IsPrivateIPv4(%q) = %v，应为 %v", ip, got, want)
		}
	}
}
