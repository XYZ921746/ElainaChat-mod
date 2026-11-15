package security

import (
	"strings"
	"testing"
)

func TestIsLocalAddr(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:5000":        true,
		"[::1]:5000":            true,
		"::ffff:127.0.0.1:5000": true,
		"192.168.1.20:5000":     false,
		"8.8.8.8:5000":          false,
	}
	for addr, want := range cases {
		if got := IsLocalAddr(addr); got != want {
			t.Fatalf("IsLocalAddr(%q)=%v，期望 %v", addr, got, want)
		}
	}
}

func TestIsLANAddr(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:5000":             true,
		"[::1]:5000":                 true,
		"192.168.1.20:5000":          true,
		"10.0.0.8:5000":              true,
		"[fe80::1]:5000":             true,
		"8.8.8.8:5000":               false,
		"192.0.2.10:5000":            false,
		"[2001:4860:4860::8888]:443": false,
	}
	for addr, want := range cases {
		if got := IsLANAddr(addr); got != want {
			t.Fatalf("IsLANAddr(%q)=%v，期望 %v", addr, got, want)
		}
	}
}

func TestIsMetadataAddress(t *testing.T) {
	for _, addr := range []string{"169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254", "[fd00:ec2::254]"} {
		if !IsMetadataAddress(addr) {
			t.Fatalf("IsMetadataAddress(%q) 应为 true", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1", "192.168.1.1", "8.8.8.8", "169.254.1.1", "fd00::1"} {
		if IsMetadataAddress(addr) {
			t.Fatalf("IsMetadataAddress(%q) 应为 false", addr)
		}
	}
}

func TestIsInternalAddress(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":            true,
		"127.1.2.3":            true,
		"169.254.169.254":      true,
		"0.0.0.0":              true,
		"10.1.2.3":             true,
		"10.0.0.5":             true,
		"172.20.1.1":           true,
		"172.16.0.1":           true,
		"172.31.255.255":       true,
		"192.168.1.1":          true,
		"::1":                  true,
		"::":                   true,
		"::ffff:192.168.1.1":   true,
		"::ffff:127.0.0.1":     true,
		"::ffff:7f00:1":        true,
		"[::ffff:127.0.0.1]":   true,
		"::ffff:10.0.0.1":      true,
		"fe80::1":              true,
		"fd00::1":              true,
		"fc00::1":              true,
		"8.8.8.8":              false,
		"1.1.1.1":              false,
		"172.32.0.1":           false,
		"172.15.0.1":           false,
		"11.0.0.1":             false,
		"2001:4860:4860::8888": false,
		"::ffff:8.8.8.8":       false,
		"2606:4700:4700::1111": false,
	}
	for ip, want := range cases {
		if got := IsInternalAddress(ip); got != want {
			t.Fatalf("IsInternalAddress(%q)=%v，期望 %v", ip, got, want)
		}
	}
}

func TestHostnameOfHostHeader(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:4199": "127.0.0.1",
		"[::1]:4199":     "[::1]",
		"My-PC:4199":     "my-pc",
		"localhost":      "localhost",
		"":               "",
	}
	for raw, want := range cases {
		if got := HostnameOfHostHeader(raw); got != want {
			t.Fatalf("HostnameOfHostHeader(%q)=%q，期望 %q", raw, got, want)
		}
	}
}

func TestIsCrossSite(t *testing.T) {
	if !IsCrossSite("cross-site", "", "x:1") {
		t.Fatal("Sec-Fetch-Site: cross-site 应判为跨站")
	}
	if IsCrossSite("same-origin", "", "x:1") {
		t.Fatal("same-origin 不应判为跨站")
	}
	if !IsCrossSite("", "http://evil.example", "x:1") {
		t.Fatal("Origin 与 Host 不同源应判为跨站")
	}
	if IsCrossSite("", "", "x:1") {
		t.Fatal("没有 Origin 也没有 Sec-Fetch-* 的客户端（curl / 本机脚本）不算跨站")
	}
}

// LocalIPv4List 必须在「网卡枚举不可用」时仍有结果：Android 11 起普通应用
// bind NETLINK_ROUTE 被 SELinux 拒绝，net.Interfaces() 恒回 netlinkrib: permission denied。
// 那条路径下只剩路由表探测，所以它自己必须能拿到出口地址。
func TestRouteProbeFallbackFindsLocalIPv4(t *testing.T) {
	got := routeProbeIPv4List()
	for _, ip := range got {
		if !IsPrivateIPv4(ip) && !strings.HasPrefix(ip, "169.254.") {
			t.Fatalf("回退只应回私网/链路本地地址，实得 %q", ip)
		}
		if ip == "127.0.0.1" {
			t.Fatalf("回退不该回回环地址")
		}
	}
	// 有网卡枚举结果时，回退结果必须是它的子集语义（同一个出口网卡）；
	// 枚举为空（安卓）时回退就是唯一来源，不能因为它为空就让共享弹窗没有 IP。
	if list := interfaceIPv4List(); len(list) > 0 {
		seen := map[string]bool{}
		for _, ip := range list {
			seen[ip] = true
		}
		for _, ip := range got {
			if !seen[ip] {
				t.Fatalf("回退探到的 %q 不在网卡枚举结果 %v 里", ip, list)
			}
		}
	}
}

// 探源地址的判据只认私网：蜂窝网卡的 CGNAT 地址（100.64/10）同一 Wi-Fi 下连不到，
// 列出来会让人照着填一个必然失败的 IP。
func TestRouteProbeRejectsCGNAT(t *testing.T) {
	if IsPrivateIPv4("100.64.1.5") {
		t.Fatal("100.64/10 是 CGNAT，不属于 RFC1918，回退不该把它当可共享地址")
	}
}
