package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 配置文件放在 data/config.json：属于运行期配置，跟着 DATA_DIR 走；
// 环境变量优先级更高，文件不存在时全部走默认值。
const configRelPath = "config.json"

// FileConfig 是文件里可配置的项。PortSet / HTTPSSet 用来区分「没写」与「写成默认值」。
type FileConfig struct {
	Port         int
	PortSet      bool
	Host         string
	HTTPS        bool
	HTTPSSet     bool
	Cert         string
	Key          string
	Password     string
	AllowedHosts []string
}

// ConfigPath 返回配置文件路径：默认 <DATA_DIR>/config.json；
// ELAINA_CONFIG_FILE 可覆盖（自动化检查用它把配置隔离到临时文件）。
func ConfigPath(dataDir string) string {
	if raw := strings.TrimSpace(os.Getenv("ELAINA_CONFIG_FILE")); raw != "" {
		if abs, err := filepath.Abs(raw); err == nil {
			return abs
		}
		return raw
	}
	return filepath.Join(dataDir, configRelPath)
}

// LoadFile 读取指定 JSON 配置文件；不存在时返回默认值。
// 未知键忽略，给后续版本留空间；已知键类型写错则报错并带文件路径。
func LoadFile(path string) (*FileConfig, error) {
	f := &FileConfig{HTTPS: true}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return f, nil
		}
		return nil, err
	}

	var doc struct {
		Port         *int     `json:"port"`
		Host         string   `json:"host"`
		HTTPS        *bool    `json:"https"`
		Cert         string   `json:"cert"`
		Key          string   `json:"key"`
		Password     string   `json:"password"`
		AllowedHosts []string `json:"allowed_hosts"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%s: JSON 解析失败：%w", path, err)
	}

	if doc.Port != nil {
		if *doc.Port < 0 || *doc.Port > 65535 {
			return nil, fmt.Errorf("%s: port 不是合法端口：%d", path, *doc.Port)
		}
		f.Port = *doc.Port
		f.PortSet = true
	}
	f.Host = strings.TrimSpace(doc.Host)
	if doc.HTTPS != nil {
		f.HTTPS = *doc.HTTPS
		f.HTTPSSet = true
	}
	f.Cert = strings.TrimSpace(doc.Cert)
	f.Key = strings.TrimSpace(doc.Key)
	f.Password = doc.Password
	for _, host := range doc.AllowedHosts {
		if host = strings.ToLower(strings.TrimSpace(host)); host != "" {
			f.AllowedHosts = append(f.AllowedHosts, host)
		}
	}
	return f, nil
}

// LoadPasswordOnly 只取 config.json 的 password 字段，其余字段一律忽略。
// 手机服务模式不用这份文件里的端口 / 监听地址 / 证书（那些由安卓侧固定），
// 但密码是用户在这台设备上用界面设置的，也由同一条改密路径写进这里；
// 不读回来就表现成「设了密码、重启即失效」。
// 读不出（不存在 / 损坏）按「没设密码」处理而不是拒绝启动：手机上没有第二个入口
// 能让用户修好它，启动失败等于把应用锁死。损坏文件不会被界面覆盖
// （SetConfigPassword 拒绝写入损坏文件），用户能从那条报错里看到它。
func LoadPasswordOnly(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var doc struct {
		Password string `json:"password"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return ""
	}
	return doc.Password
}

// configWriteMu 串行化同一进程内对配置文件的读改写：并发改密若各自从旧内容
// 生成新文档，后写者会丢掉先写者的字段；临时文件用唯一名，写完 fsync 再原子替换。
var configWriteMu sync.Mutex

func writeConfigAtomic(path string, text []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := file.Name()
	cleanup := func() { _ = file.Close(); _ = os.Remove(tmp) }
	if _, err := file.Write(text); err != nil {
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	var renameErr error
	for attempt := 0; attempt < 5; attempt++ {
		renameErr = os.Rename(tmp, path)
		if renameErr == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = os.Remove(tmp)
	return renameErr
}

// SetConfigPassword 把 password 写进指定配置文件：已有文件保留其它字段只改这一项；
// 文件不存在时写最小对象（其余字段走运行时默认，不钉死样例值）。损坏的现有文件
// 必须报错而不是覆盖 —— 那是用户手写的配置，静默重建等于丢配置。
func SetConfigPassword(path, password string) error {
	configWriteMu.Lock()
	defer configWriteMu.Unlock()
	doc := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(raw, &doc) != nil || doc == nil {
			return fmt.Errorf("%s: JSON 解析失败，拒绝写入 password", path)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	doc["password"] = password
	text, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return writeConfigAtomic(path, text)
}

// EnsureSample 在配置文件不存在时写一份默认配置：值就是当前生效的默认设置，开发者按需改。
func EnsureSample(configPath string) error {
	if _, err := os.Stat(configPath); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
		return err
	}
	sample := `{
  "port": 3999,
  "host": "127.0.0.1",
  "https": true,
  "cert": null,
  "key": null,
  "password": "",
  "allowed_hosts": []
}
`
	// 先写临时文件再改名：两个实例同时首启时，读者只会看到完整 JSON，不会读到写了一半的样例。
	tmp := fmt.Sprintf("%s.%d.tmp", configPath, os.Getpid())
	if err := os.WriteFile(tmp, []byte(sample), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, configPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (cfg *Config) applyFileConfig(f *FileConfig, configPath string) error {
	if _, ok := os.LookupEnv("HOST"); !ok && strings.TrimSpace(f.Host) != "" {
		cfg.Host = strings.TrimSpace(f.Host)
	}
	// port 写 0 表示「由系统分配」：本机不想固定端口、又不想让程序自己挑一个时用。
	if f.PortSet {
		cfg.Port = f.Port
	}
	cfg.HTTPS = f.HTTPS
	cfg.Password = f.Password
	cfg.PasswordFromConfig = f.Password != ""
	cfg.AllowedHosts = append(cfg.AllowedHosts, f.AllowedHosts...)
	if raw, ok := os.LookupEnv("ELAINA_HTTPS"); ok && strings.TrimSpace(raw) != "" {
		switch strings.ToLower(strings.TrimSpace(raw)) {
		case "1", "true", "yes", "on":
			cfg.HTTPS = true
		case "0", "false", "no", "off":
			cfg.HTTPS = false
		default:
			return fmt.Errorf("ELAINA_HTTPS 只认 0/1：%q", raw)
		}
	}
	if !cfg.HTTPS {
		cfg.CertFile, cfg.KeyFile = "", ""
		return nil
	}

	certPath, keyPath := f.Cert, f.Key
	if v := strings.TrimSpace(os.Getenv("ELAINA_CERT_FILE")); v != "" {
		certPath = v
	}
	if v := strings.TrimSpace(os.Getenv("ELAINA_KEY_FILE")); v != "" {
		keyPath = v
	}
	if (certPath == "") != (keyPath == "") {
		return fmt.Errorf("cert 与 key 必须同时配置（当前只给了一个）")
	}
	configDir := filepath.Dir(configPath)
	if certPath != "" {
		cfg.CertFile = resolveRelative(configDir, certPath)
		cfg.KeyFile = resolveRelative(configDir, keyPath)
		cfg.CertExplicit = true
		if !fileExists(cfg.CertFile) {
			return fmt.Errorf("配置的证书不存在：%s", cfg.CertFile)
		}
		if !fileExists(cfg.KeyFile) {
			return fmt.Errorf("配置的私钥不存在：%s", cfg.KeyFile)
		}
	} else {
		// 默认就是 data 目录下的自签证书；自定义证书放同一位置、或在配置里指定路径即可。
		cfg.CertFile = filepath.Join(configDir, "cert.pem")
		cfg.KeyFile = filepath.Join(configDir, "key.pem")
	}

	return nil
}

func resolveRelative(baseDir, raw string) string {
	if filepath.IsAbs(raw) {
		return raw
	}
	return filepath.Join(baseDir, raw)
}

func fileExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}
