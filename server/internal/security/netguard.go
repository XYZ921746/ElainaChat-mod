// Package security 收拢网络边界判定：本机、回环、内网、跨站。
// 这些判定同时用在「谁能免密」「重定向要不要跳过」「中继能不能发」上，
// 分散写会变成多份安全判据，改一处漏一处。
package security

import (
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// IsLocalAddr 判断连接来源是不是回环。它只决定「本机免密」，不决定「能不能操作电脑」——
// 后者由密码登录授予。
func IsLocalAddr(remoteAddr string) bool {
	host := hostOnly(remoteAddr)
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost"
}

// hostOnly 从 RemoteAddr（host:port / [::1]:port）里取出不带端口的地址。
// net.SplitHostPort 不认未加方括号的 IPv6 写法，所以失败时再按最后一个冒号兜底。
func hostOnly(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return strings.Trim(host, "[]")
	}
	if i := strings.LastIndex(remoteAddr, ":"); i > 0 && !strings.Contains(remoteAddr[i+1:], ":") {
		return strings.Trim(remoteAddr[:i], "[]")
	}
	return strings.Trim(remoteAddr, "[]")
}

// IsLANAddr 判断连接来源是否来自本机或同一局域网。
// 中继用它区分「用户自己网络里的设备」与公网来源：前者可以访问本机/内网服务商
// （Ollama、LM Studio、局域网网关），后者仍按 SSRF 拦截。
func IsLANAddr(remoteAddr string) bool {
	host := hostOnly(remoteAddr)
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return IsInternalAddress(ip.String())
	}
	return false
}

// IsLoopbackHostname 判断 Host 头里的主机名是否本机。localhost 本身就是安全上下文，
// 为麦克风跳 HTTPS 没有意义，只会多一次证书警告。
func IsLoopbackHostname(h string) bool {
	switch strings.ToLower(strings.TrimSpace(h)) {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// MappedIPv4 把 IPv4-mapped / IPv4-compatible 的 IPv6 地址还原成点分 IPv4。
// 只按字符串前缀判内网会漏掉 ::ffff:127.0.0.1：它连的就是回环，字符串却既不以 127. 开头也不是 ::1。
func MappedIPv4(raw string) string {
	s := strings.ToLower(strings.Trim(strings.TrimSpace(raw), "[]"))
	if !strings.Contains(s, ":") {
		return ""
	}
	if strings.HasPrefix(s, "::ffff:") {
		rest := strings.TrimPrefix(s, "::ffff:")
		if ip := net.ParseIP(rest); ip != nil && ip.To4() != nil {
			return ip.String()
		}
	}
	if strings.HasPrefix(s, "::") {
		rest := strings.TrimPrefix(s, "::")
		if ip := net.ParseIP(rest); ip != nil && ip.To4() != nil {
			return ip.String()
		}
	}
	if ip := net.ParseIP(s); ip != nil && ip.To4() != nil {
		return ip.String()
	}
	return ""
}

// IsPrivateIPv4 判断 RFC1918 私网地址。
func IsPrivateIPv4(ip string) bool {
	parts := strings.Split(strings.TrimSpace(ip), ".")
	if len(parts) != 4 {
		return false
	}
	nums := make([]int, 4)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return false
		}
		nums[i] = n
	}
	switch {
	case nums[0] == 10:
		return true
	case nums[0] == 172 && nums[1] >= 16 && nums[1] <= 31:
		return true
	case nums[0] == 192 && nums[1] == 168:
		return true
	}
	return false
}

// IsInternalAddress 判断地址是否指向本机或内网：回环、私网、链路本地、唯一本地、CGNAT。
// 中继在发请求前用它挡 SSRF，云元数据地址 169.254.169.254 必须算在内网。
//
// 先经 netip 规范化再判断：字符串前缀判据认不出 0:0:0:0:0:0:0:1 这类展开写法，
// 也认不出带 zone 的 fe80::1%eth0；这是公共安全判据，新调用点不该各自补一遍写法。
func IsInternalAddress(raw string) bool {
	addr, ok := parseAddrLoose(raw)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if addr.Is4() {
		b := addr.As4()
		return b[0] == 127 || // 整段回环
			(b[0] == 169 && b[1] == 254) || // 链路本地（含云元数据）
			(b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 0) || // 未指定
			(b[0] == 100 && b[1] >= 64 && b[1] <= 127) || // CGNAT 100.64.0.0/10
			addr.IsPrivate() // RFC1918
	}
	return addr.IsLoopback() || // ::1
		addr.IsUnspecified() || // ::
		addr.IsLinkLocalUnicast() || // fe80::/10
		addr.IsLinkLocalMulticast() ||
		addr.IsPrivate() // fc00::/7 唯一本地
}

// parseAddrLoose 解析可能带方括号、带 zone（fe80::1%eth0）或 IPv4-mapped 的地址字面量。
// netip.ParseAddr 不认方括号，所以先剥掉；zone 用 ParseAddrPort 之外的方式补回。
func parseAddrLoose(raw string) (netip.Addr, bool) {
	s := strings.TrimSpace(raw)
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	if s == "" {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr, true
	}
	// 带 zone 的 IPv6：拆开 zone 再解析，zone 不影响「是不是内网」。
	if i := strings.LastIndex(s, "%"); i > 0 {
		if addr, err := netip.ParseAddr(s[:i]); err == nil {
			return addr, true
		}
	}
	return netip.Addr{}, false
}

// 云厂商元数据服务地址：读到的是本机凭据，不属于「局域网里的 AI 服务商」，
// 因此无论请求来自本机、局域网还是公网都拒绝。
var metadataAddrs = map[string]bool{
	"169.254.169.254": true, // AWS / Azure / GCP / OpenStack
	"169.254.170.2":   true, // AWS ECS task metadata
	"100.100.100.200": true, // 阿里云
	"fd00:ec2::254":   true, // AWS IPv6
}

// IsMetadataAddress 判断地址是否为云厂商元数据服务。中继在拨号阶段按解析出的 IP 再判一次：
// 局域网来源放行内网目标后，DNS rebinding 仍不能把请求带到元数据地址。
func IsMetadataAddress(raw string) bool {
	s := strings.ToLower(strings.Trim(strings.TrimSpace(raw), "[]"))
	if v4 := MappedIPv4(s); v4 != "" {
		s = v4
	}
	return metadataAddrs[s]
}

// LocalIPv4List 返回本机非回环 IPv4，私网地址排前面：手机能连的通常是 192.168 / 10 / 172.16-31，
// VPN 与虚拟网卡常在公网段，会把用户带偏。
func LocalIPv4List() []string {
	out := interfaceIPv4List()
	if len(out) == 0 {
		// 网卡枚举在安卓上整条不可用：Android 11 起 SELinux 的 untrusted_app 域
		// 禁止普通应用 bind NETLINK_ROUTE，net.Interfaces() 只会回 netlinkrib: permission denied。
		// 退回按路由表探源地址 —— 它拿到的是同一份信息里真正有用的那一项：
		// 出口网卡的地址，也就是同一 Wi-Fi 下别的设备能连到的那个。
		out = routeProbeIPv4List()
	}
	sortPrivateFirst(out)
	return out
}

// interfaceIPv4List 走 netlink 枚举所有网卡（桌面端的主路径）。
func interfaceIPv4List() []string {
	var out []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipNet.IP.To4()
			if ip4 == nil || ip4.IsLoopback() {
				continue
			}
			out = append(out, ip4.String())
		}
	}
	return out
}

// probeTargets 是探源地址用的目标。前三项落在各私网段：设备就在该网段时，
// 路由表按直连路由选中该网卡；不在该网段时退回默认路由，结果同样是出口网卡。
// 后两项保证「连上 Wi-Fi 但局域网段特殊」时仍有一条默认路由可用。
var probeTargets = []string{
	"192.168.1.1:53",
	"10.0.0.1:53",
	"172.16.0.1:53",
	"223.5.5.5:53",
	"8.8.8.8:53",
}

// routeProbeIPv4List 用 UDP connect 探出口地址。connect 只查路由表、不发包，
// 所以没有外网也能拿到结果；拿不到说明确实没有可用路由（例如没连任何网络）。
// 只保留私网与链路本地：探出来的可能是蜂窝网卡的 CGNAT 地址（100.64/10），
// 那个地址同一 Wi-Fi 下的设备连不到，列出来只会让人照着填一个必然失败的 IP。
func routeProbeIPv4List() []string {
	var out []string
	seen := map[string]bool{}
	for _, target := range probeTargets {
		conn, err := net.DialTimeout("udp4", target, 300*time.Millisecond)
		if err != nil {
			continue
		}
		if ua, ok := conn.LocalAddr().(*net.UDPAddr); ok && ua.IP != nil {
			if ip4 := ua.IP.To4(); ip4 != nil {
				s := ip4.String()
				if !ip4.IsLoopback() && !ip4.IsUnspecified() && !seen[s] &&
					(IsPrivateIPv4(s) || strings.HasPrefix(s, "169.254.")) {
					seen[s] = true
					out = append(out, s)
				}
			}
		}
		_ = conn.Close()
	}
	return out
}

func sortPrivateFirst(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0; j-- {
			if IsPrivateIPv4(list[j]) && !IsPrivateIPv4(list[j-1]) {
				list[j], list[j-1] = list[j-1], list[j]
			} else {
				break
			}
		}
	}
}

// HostnameOfHostHeader 从 Host 头取出主机名；IPv6 字面量要保留方括号。
func HostnameOfHostHeader(raw string) string {
	h := strings.ToLower(strings.TrimSpace(raw))
	if h == "" {
		return ""
	}
	if strings.HasPrefix(h, "[") {
		if end := strings.Index(h, "]"); end > 0 {
			return h[:end+1]
		}
		return h
	}
	if i := strings.LastIndex(h, ":"); i > 0 {
		return h[:i]
	}
	return h
}

// IsCrossSite 判断请求是否来自第三方页面。第三方页面的 GET 不带 Origin，
// 但会带 Sec-Fetch-Site: cross-site；两者都没有的客户端（curl / 本机脚本）按同源处理。
func IsCrossSite(secFetchSite, origin, host string) bool {
	if sfs := strings.ToLower(strings.TrimSpace(secFetchSite)); sfs != "" {
		return sfs != "same-origin" && sfs != "none"
	}
	if strings.TrimSpace(origin) == "" {
		return false
	}
	return hostOfURL(origin) != strings.TrimSpace(host)
}

// hostOfURL 取出 URL 的 host:port；解析失败按跨站处理，宁严勿松。
func hostOfURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "\x00invalid"
	}
	return u.Host
}
