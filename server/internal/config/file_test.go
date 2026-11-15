package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func unsetEnv(t *testing.T, key string) {
	t.Helper()
	old, ok := os.LookupEnv(key)
	_ = os.Unsetenv(key)
	t.Cleanup(func() {
		if ok {
			_ = os.Setenv(key, old)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func configPathFor(root string) string {
	return filepath.Join(root, "config.json")
}

func writeConfig(t *testing.T, root, body string) {
	t.Helper()
	path := configPathFor(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadFileAndApply(t *testing.T) {
	dir := t.TempDir()
	unsetEnv(t, "HOST")
	unsetEnv(t, "PORT")
	unsetEnv(t, "ELAINA_HTTPS")
	unsetEnv(t, "ELAINA_CERT_FILE")
	unsetEnv(t, "ELAINA_KEY_FILE")
	writeConfig(t, dir, `{
  "port": 4123,
  "host": "127.0.0.1",
  "https": false,
  "allowed_hosts": ["chat.example.com", " My-PC.local "]
}`)

	path := configPathFor(dir)
	f, err := LoadFile(path)
	if err != nil {
		t.Fatalf("读取配置失败：%v", err)
	}
	cfg := &Config{DataDir: dir, Host: "0.0.0.0", Port: 3999, HTTPS: true}
	if err := cfg.applyFileConfig(f, path); err != nil {
		t.Fatalf("应用配置失败：%v", err)
	}
	if cfg.Port != 4123 {
		t.Fatalf("port 未生效：%d", cfg.Port)
	}
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("host 未生效：%s", cfg.Host)
	}
	if cfg.HTTPS {
		t.Fatalf("https=false 应关闭 HTTPS")
	}
	if cfg.CertFile != "" || cfg.KeyFile != "" {
		t.Fatalf("HTTPS 关闭时不应保留证书路径")
	}
	want := []string{"chat.example.com", "my-pc.local"}
	for _, host := range want {
		found := false
		for _, got := range cfg.AllowedHosts {
			if got == host {
				found = true
			}
		}
		if !found {
			t.Fatalf("allowed_hosts 缺少 %s：%v", host, cfg.AllowedHosts)
		}
	}
}

func TestPortZeroMeansSystemAssigned(t *testing.T) {
	dir := t.TempDir()
	unsetEnv(t, "PORT")
	writeConfig(t, dir, `{"port": 0}`)
	path := configPathFor(dir)
	f, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{DataDir: dir, Port: 3999, HTTPS: true}
	if err := cfg.applyFileConfig(f, path); err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 0 {
		t.Fatalf("port=0 应由系统分配：port=%d", cfg.Port)
	}
}

func TestCustomCertPairMustExist(t *testing.T) {
	dir := t.TempDir()
	unsetEnv(t, "ELAINA_CERT_FILE")
	unsetEnv(t, "ELAINA_KEY_FILE")
	writeConfig(t, dir, `{"cert": "my-cert.pem", "key": "my-key.pem"}`)
	path := configPathFor(dir)
	f, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{DataDir: dir, Port: 3999, HTTPS: true}
	if err := cfg.applyFileConfig(f, path); err == nil {
		t.Fatalf("自定义证书不存在时应报错")
	}
}

func TestCustomCertRelativeToDataDir(t *testing.T) {
	dir := t.TempDir()
	unsetEnv(t, "ELAINA_CERT_FILE")
	unsetEnv(t, "ELAINA_KEY_FILE")
	for _, name := range []string{"my-cert.pem", "my-key.pem"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("placeholder"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig(t, dir, `{"cert": "my-cert.pem", "key": "my-key.pem"}`)
	path := configPathFor(dir)
	f, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{DataDir: dir, Port: 3999, HTTPS: true}
	if err := cfg.applyFileConfig(f, path); err != nil {
		t.Fatal(err)
	}
	if cfg.CertFile != filepath.Join(dir, "my-cert.pem") || cfg.KeyFile != filepath.Join(dir, "my-key.pem") {
		t.Fatalf("相对证书路径未按 data 目录解析：%s / %s", cfg.CertFile, cfg.KeyFile)
	}
}

func TestEnsureSampleDoesNotOverwrite(t *testing.T) {
	dir := t.TempDir()
	path := configPathFor(dir)
	if err := EnsureSample(path); err != nil {
		t.Fatalf("写样例失败：%v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "\"port\": 3999") || strings.Contains(string(raw), "_help") {
		t.Fatalf("样例应直接写出默认值（port=3999，且无说明字段）：%s", raw)
	}

	custom := `{"port": 4567}`
	if err := os.WriteFile(path, []byte(custom), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureSample(path); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if string(raw) != custom {
		t.Fatalf("已有配置被样例覆盖")
	}
}

func TestInvalidJSONRejected(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"port": 4000,}`)
	if _, err := LoadFile(configPathFor(dir)); err == nil {
		t.Fatalf("非法 JSON 应报错")
	}
}

func TestWrongTypeRejected(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"port": "4000"}`)
	if _, err := LoadFile(configPathFor(dir)); err == nil {
		t.Fatalf("port 为字符串时应报错")
	}
}

func TestPasswordFromConfig(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"password": "Str0ngPass!"}`)
	path := configPathFor(dir)
	f, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &Config{DataDir: dir, Port: 3999, HTTPS: true}
	if err := cfg.applyFileConfig(f, path); err != nil {
		t.Fatal(err)
	}
	if !cfg.PasswordFromConfig || cfg.Password != "Str0ngPass!" {
		t.Fatalf("配置文件密码未生效：from=%v password=%q", cfg.PasswordFromConfig, cfg.Password)
	}
}

func TestConfigPathEnvOverride(t *testing.T) {
	dir := t.TempDir()
	override := filepath.Join(dir, "custom", "server.json")
	t.Setenv("ELAINA_CONFIG_FILE", override)
	if got := ConfigPath(filepath.Join(dir, "app")); got != override {
		t.Fatalf("ELAINA_CONFIG_FILE 未生效：%s", got)
	}
}

func TestSetConfigPasswordPreservesOtherFields(t *testing.T) {
	dir := t.TempDir()
	path := configPathFor(dir)
	writeConfig(t, dir, `{"port":5000,"host":"0.0.0.0","password":"OldPass1","allowed_hosts":["localhost"]}`)

	if err := SetConfigPassword(path, "NewPass9x"); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "NewPass9x" || !cfg.PortSet || cfg.Port != 5000 || cfg.Host != "0.0.0.0" || len(cfg.AllowedHosts) != 1 {
		t.Fatalf("其它字段应保留且 password 更新：%+v", cfg)
	}
}

func TestSetConfigPasswordCreatesMinimalFile(t *testing.T) {
	dir := t.TempDir()
	path := configPathFor(filepath.Join(dir, "nested", "config.json"))
	if err := SetConfigPassword(path, "NewPass9x"); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "NewPass9x" || cfg.PortSet || cfg.Host != "" {
		t.Fatalf("缺失文件应写最小对象，未列字段走运行时默认：%+v", cfg)
	}
}

func TestSetConfigPasswordRefusesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := configPathFor(dir)
	writeConfig(t, dir, "{not-json")
	if err := SetConfigPassword(path, "NewPass9x"); err == nil {
		t.Fatal("损坏的配置文件应报错而不是覆盖")
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "{not-json") {
		t.Fatalf("损坏文件应原样保留：%v %s", err, raw)
	}
}

// 手机服务模式不读 config.json 的端口 / 监听 / 证书（那些由安卓侧固定），
// 但密码是用户在这台设备上用界面设的、也写进同一个文件：必须能读回来，
// 否则表现成「设了密码、重启即失效」。
func TestServiceModeLoadsPasswordFromConfig(t *testing.T) {
	dir := t.TempDir()
	writeConfig(t, dir, `{"port": 5000, "host": "0.0.0.0", "password": "Mobil3Pass"}`)
	t.Setenv("ELAINA_SERVICE_MODE", "1")
	t.Setenv("DATA_DIR", dir)
	// ELAINA_CONFIG_FILE 优先于 DATA_DIR：外层检查夹具会给子进程注一份共享配置，
	// 不清掉就会读到别人的文件，用例变成依赖运行环境。
	unsetEnv(t, "ELAINA_CONFIG_FILE")

	cfg, err := Load(nil)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ServiceMode {
		t.Fatal("ELAINA_SERVICE_MODE=1 应进入服务模式")
	}
	if !cfg.PasswordFromConfig || cfg.Password != "Mobil3Pass" {
		t.Fatalf("服务模式没读回密码：from=%v password=%q", cfg.PasswordFromConfig, cfg.Password)
	}
	// 端口与监听地址仍由安卓侧决定：文件里写的 5000 / 0.0.0.0 不得生效。
	if cfg.Port != 0 {
		t.Fatalf("服务模式端口应交给内核分配，实际 %d", cfg.Port)
	}
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("服务模式只绑回环，实际 %q", cfg.Host)
	}
	if cfg.ConfigFile != configPathFor(dir) {
		t.Fatalf("服务模式也要知道 config 路径（改密要写回去）：%q", cfg.ConfigFile)
	}
}

// 配置文件不存在 / 损坏时按「没设密码」处理：手机上启动失败等于把应用锁死。
func TestServiceModeToleratesMissingOrCorruptConfig(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"不存在", ""},
		{"损坏", "{not-json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.body != "" {
				writeConfig(t, dir, tc.body)
			}
			t.Setenv("ELAINA_SERVICE_MODE", "1")
			t.Setenv("DATA_DIR", dir)
			unsetEnv(t, "ELAINA_CONFIG_FILE")

			cfg, err := Load(nil)
			if err != nil {
				t.Fatalf("不应拒绝启动：%v", err)
			}
			if cfg.PasswordFromConfig || cfg.Password != "" {
				t.Fatalf("读不出密码时应视为未设置：from=%v password=%q", cfg.PasswordFromConfig, cfg.Password)
			}
		})
	}
}
