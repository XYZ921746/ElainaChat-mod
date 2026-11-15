package tlsutil

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEnsureGeneratesAndReusesSelfSignedCert(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	info, err := Ensure(certPath, keyPath, false)
	if err != nil {
		t.Fatalf("首次生成失败：%v", err)
	}
	if !info.Generated {
		t.Fatalf("首次调用应生成证书")
	}
	if info.Custom {
		t.Fatalf("自动生成的证书不应标记为自定义")
	}

	block, _ := pem.Decode(info.Cert)
	if block == nil {
		t.Fatalf("证书不是合法 PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("解析证书失败：%v", err)
	}
	if !strings.Contains(cert.Subject.String(), "ElainaChat") {
		t.Fatalf("自签证书 subject 缺少应用名：%s", cert.Subject)
	}
	if !cert.IsCA {
		t.Fatalf("自签证书需要作为信任锚（IsCA=true）")
	}
	if !containsString(cert.DNSNames, "localhost") {
		t.Fatalf("SAN 缺少 localhost：%v", cert.DNSNames)
	}
	if !containsIP(cert, "127.0.0.1") || !containsIP(cert, "::1") {
		t.Fatalf("SAN 缺少回环地址：%v", cert.IPAddresses)
	}

	again, err := Ensure(certPath, keyPath, false)
	if err != nil {
		t.Fatalf("复用已有证书失败：%v", err)
	}
	if again.Generated {
		t.Fatalf("已有有效证书不应重复生成")
	}
	if string(again.Cert) != string(info.Cert) {
		t.Fatalf("复用时应返回原证书")
	}

	forced, err := Ensure(certPath, keyPath, true)
	if err != nil {
		t.Fatalf("--reset-cert 换新失败：%v", err)
	}
	if !forced.Generated || string(forced.Cert) == string(info.Cert) {
		t.Fatalf("--reset-cert 应生成不同的证书")
	}
}

func TestEnsurePreservesCustomCert(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "custom-cert.pem")
	keyPath := filepath.Join(dir, "custom-key.pem")
	customCert, customKey := makeCustomPair(t)

	if err := os.WriteFile(certPath, customCert, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, customKey, 0o600); err != nil {
		t.Fatal(err)
	}

	info, err := Ensure(certPath, keyPath, true)
	if err != nil {
		t.Fatalf("读取自定义证书失败：%v", err)
	}
	if !info.Custom || info.Generated {
		t.Fatalf("自定义证书不应被生成/覆盖（custom=%v generated=%v）", info.Custom, info.Generated)
	}
	raw, _ := os.ReadFile(certPath)
	if string(raw) != string(customCert) {
		t.Fatalf("自定义证书文件被改写了")
	}
}

func TestEnsureRejectsMismatchedPair(t *testing.T) {
	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")
	if _, err := Ensure(certPath, keyPath, false); err != nil {
		t.Fatal(err)
	}
	// 换成另一对的自签私钥，必须报“不匹配”而不是默默起一个坏 TLS。
	_, otherKey := makeCustomPair(t)
	if err := os.WriteFile(keyPath, otherKey, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(certPath, keyPath, false); err == nil {
		t.Fatalf("证书与私钥不匹配时应报错")
	}
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if strings.EqualFold(v, want) {
			return true
		}
	}
	return false
}

func containsIP(cert *x509.Certificate, want string) bool {
	for _, ip := range cert.IPAddresses {
		if ip.String() == want {
			return true
		}
	}
	return false
}

func makeCustomPair(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "custom-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	return certPEM, keyPEM
}
