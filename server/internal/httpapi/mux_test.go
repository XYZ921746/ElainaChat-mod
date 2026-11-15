package httpapi

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/tlsutil"
)

// 同一个监听端口必须同时认 HTTP 与 HTTPS：地址栏只输 IP 会被补成 http://，
// 而麦克风只在 https / localhost 下可用。两个协议各自用真实客户端验证一次。
func TestMuxServesHTTPAndHTTPSOnSamePort(t *testing.T) {
	dir := t.TempDir()
	cert, err := tlsutil.Ensure(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), false)
	if err != nil {
		t.Fatalf("准备证书失败：%v", err)
	}

	authStore := auth.NewStore(dir, filepath.Join(dir, ".local-auth.json"), logx.Discard())
	if _, err := authStore.Ensure(); err != nil {
		t.Fatalf("初始化鉴权失败：%v", err)
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	})
	mux, err := ListenAndServe(&config.Config{Host: "127.0.0.1"}, logx.Discard(), authStore, handler, cert, 0)
	if err != nil {
		t.Fatalf("监听失败：%v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = mux.Shutdown(ctx)
	}()

	port := mux.Port()
	if port <= 0 {
		t.Fatalf("未拿到监听端口")
	}
	base := fmt.Sprintf("127.0.0.1:%d", port)

	resp, err := http.Get("http://" + base + "/")
	if err != nil {
		t.Fatalf("HTTP 请求失败：%v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("HTTP 应答异常：%d %q", resp.StatusCode, body)
	}

	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(cert.Cert) {
		t.Fatalf("证书无法加入信任池")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs:    pool,
		ServerName: "localhost",
	}}}
	resp, err = client.Get("https://" + base + "/")
	if err != nil {
		t.Fatalf("HTTPS 请求失败：%v", err)
	}
	body, _ = io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("HTTPS 应答异常：%d %q", resp.StatusCode, body)
	}
}
