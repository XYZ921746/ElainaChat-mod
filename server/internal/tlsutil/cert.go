// Package tlsutil 负责桌面端 HTTPS 的自签证书：浏览器只在 https / localhost 下给麦克风，
// 局域网设备要语音输入就得走 HTTPS；自签证书首次访问需要手动点「继续前往」。
package tlsutil

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"elainachat/server/internal/security"
)

const validity = 825 * 24 * time.Hour

// Info 是本次启动可用的证书材料。Generated 表示这次重新生成了证书。
type Info struct {
	Cert      []byte
	Key       []byte
	Generated bool
	Custom    bool
	DaysLeft  float64
}

// Ensure 读取指定路径的证书；自签证书剩余不足 30 天时换新。
// 用户自己放的证书一律不动：只有 subject 带应用名的才被视为自签；
// force（--reset-cert）也不会覆盖用户自己的证书。
func Ensure(certPath, keyPath string, force bool) (*Info, error) {
	certPEM, certErr := os.ReadFile(certPath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr == nil && keyErr == nil && len(certPEM) > 0 && len(keyPEM) > 0 {
		days, selfMade := describe(certPEM)
		if !selfMade {
			if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
				return nil, fmt.Errorf("自定义证书与私钥不匹配：%w", err)
			}
			return &Info{Cert: certPEM, Key: keyPEM, Custom: true, DaysLeft: days}, nil
		}
		if !force && days >= 30 {
			if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
				return nil, fmt.Errorf("自签证书与私钥不匹配：%w", err)
			}
			return &Info{Cert: certPEM, Key: keyPEM, DaysLeft: days}, nil
		}
	}

	newCert, newKey, err := generate()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(certPath), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(certPath, newCert, 0o600); err != nil {
		return nil, err
	}
	if err := os.WriteFile(keyPath, newKey, 0o600); err != nil {
		return nil, err
	}
	days, _ := describe(newCert)
	return &Info{Cert: newCert, Key: newKey, Generated: true, DaysLeft: days}, nil
}

// TLSConfig 只开 TLS 1.2 及以上：再低的协议系统库也已经拒绝。
func (i *Info) TLSConfig() (*tls.Config, error) {
	pair, err := tls.X509KeyPair(i.Cert, i.Key)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS12,
	}, nil
}

// describe 返回剩余天数，以及证书是不是我们自己签的。
func describe(certPEM []byte) (float64, bool) {
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return 0, false
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return 0, false
	}
	return time.Until(cert.NotAfter).Hours() / 24, strings.Contains(cert.Subject.String(), "ElainaChat")
}

func generate() (certPEM, keyPEM []byte, err error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}

	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "ElainaChat", Organization: []string{"ElainaChat"}},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(validity),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	// SAN 必须覆盖用户实际访问的地址：localhost、回环、主机名与局域网 IP。
	// 少一个就会在「已点继续前往」之后再叠一层证书名称不匹配。
	tmpl.DNSNames = []string{"localhost"}
	if hostname, hostErr := os.Hostname(); hostErr == nil && hostname != "" && !strings.EqualFold(hostname, "localhost") {
		tmpl.DNSNames = append(tmpl.DNSNames, hostname)
	}
	tmpl.IPAddresses = []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	for _, ip := range security.LocalIPv4List() {
		if parsed := net.ParseIP(ip); parsed != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, parsed)
		}
	}

	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if certPEM == nil || keyPEM == nil {
		return nil, nil, fmt.Errorf("证书编码失败")
	}
	return certPEM, keyPEM, nil
}
