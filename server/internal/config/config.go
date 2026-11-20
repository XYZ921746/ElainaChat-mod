// Package config 负责定位应用根目录与运行期路径，并把环境变量收敛成一份只读配置。
// 路径判定必须允许环境变量覆盖：自动化检查要跑真实读写，不能落到用户真实的 data/。
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Config 是服务启动所需的全部外部输入。字段在 Load 之后不再修改。
type Config struct {
	AppRoot   string
	WebRoot   string
	DataDir   string
	LogDir    string
	ModsDir   string
	SkillsDir string

	Host        string
	Port        int
	OpenBrowser bool

	Edition string
	Version string

	LogToFile    bool
	LogChat      bool
	AllowedHosts []string

	// 桌面端同端口 HTTP/HTTPS。HTTPS=false 时纯 HTTP；CertFile/KeyFile 为空表示使用自签证书。
	HTTPS        bool
	CertFile     string
	KeyFile      string
	CertExplicit bool
	ConfigFile   string

	// 配置文件里的访问密码：明文只存在于 data/config.json，哈希在内存里派生，
	// data/auth.json 仅在 config 没写 password 时向下兼容读取。
	Password           string
	PasswordFromConfig bool

	// 手机端（APK）没有 web/ 静态根：服务只监听回环、提供日志/中继/插件半边。
	// 这个模式也把「同名 Origin」换成 Capacitor 的 https://localhost，并把端口写到
	// PortFile 供 Java 服务进程读取（内核分配端口，Java 侧不猜）。
	ServiceMode     bool
	PortFile        string
	PluginStateFile string
}

// Load 读取环境变量与命令行，返回配置。命令行只认 --reset-cert 这类一次性开关，
// 端口与目录一律走环境变量，避免同一份设置有两个来源。
func Load(argv []string) (*Config, error) {
	serviceMode := envString("ELAINA_SERVICE_MODE", "0") == "1"

	var appRoot string
	var err error
	if serviceMode {
		// 手机端没有 web/index.html，不能按桌面那套向上找；用显式根或数据目录兜底。
		appRoot = envPath("ELAINA_APP_ROOT", envPath("DATA_DIR", ""))
		if appRoot == "" {
			if appRoot, err = os.Getwd(); err != nil {
				return nil, fmt.Errorf("服务模式需要 ELAINA_APP_ROOT 或 DATA_DIR")
			}
		}
	} else {
		if appRoot, err = resolveAppRoot(); err != nil {
			return nil, err
		}
	}

	hostDefault := "127.0.0.1"
	if serviceMode {
		// 安卓上非 root 进程不能监听对外端口；只绑回环。
		hostDefault = "127.0.0.1"
	}
	cfg := &Config{
		AppRoot:         appRoot,
		WebRoot:         filepath.Join(appRoot, "web"),
		DataDir:         envPath("DATA_DIR", filepath.Join(appRoot, "data")),
		LogDir:          envPath("LOG_DIR", ""),
		ModsDir:         envPath("MODS_DIR", filepath.Join(appRoot, "mods")),
		SkillsDir:       envPath("SKILLS_DIR", filepath.Join(appRoot, "skills")),
		Host:            envString("HOST", hostDefault),
		Port:            3999,
		OpenBrowser:     envString("OPEN_BROWSER", "0") == "1",
		Edition:         normalizeEdition(envString("ELAINA_EDITION", "")),
		Version:         resolveVersion(appRoot),
		LogToFile:       envString("LOG_TO_FILE", "1") != "0",
		LogChat:         envString("LOG_CHAT", "1") != "0",
		AllowedHosts:    splitList(envString("ALLOWED_HOSTS", "")),
		HTTPS:           !serviceMode,
		ServiceMode:     serviceMode,
		PortFile:        strings.TrimSpace(os.Getenv("ELAINA_PORT_FILE")),
		PluginStateFile: strings.TrimSpace(os.Getenv("ELAINA_PLUGIN_STATE_FILE")),
	}
	if serviceMode {
		// 端口 0 = 让内核挑一个空闲端口，再写进 PortFile。
		cfg.Port = 0
		cfg.Edition = "android"
		// 端口 / 监听地址 / 证书在手机上由安卓侧固定，这份文件里只剩密码是用户可设的：
		// 界面改密把它写进同一个路径，这里必须读回来，否则重启后密码凭空消失。
		cfg.ConfigFile = ConfigPath(cfg.DataDir)
		cfg.Password = LoadPasswordOnly(cfg.ConfigFile)
		cfg.PasswordFromConfig = cfg.Password != ""
	} else {
		// <DATA_DIR>/config.json 提供端口 / 监听地址 / HTTPS / 证书路径；
		// 环境变量在下面覆盖它，保持「命令行优先于文件」。
		configPath := ConfigPath(cfg.DataDir)
		fileCfg, fileErr := LoadFile(configPath)
		if fileErr != nil {
			return nil, fileErr
		}
		if err := cfg.applyFileConfig(fileCfg, configPath); err != nil {
			return nil, err
		}
		cfg.ConfigFile = configPath
	}
	if raw, ok := os.LookupEnv("PORT"); ok && strings.TrimSpace(raw) != "" {
		n, convErr := strconv.Atoi(strings.TrimSpace(raw))
		if convErr != nil || n < 0 || n > 65535 {
			return nil, fmt.Errorf("PORT 不是合法端口：%q", raw)
		}
		cfg.Port = n
	}
	if cfg.LogDir == "" {
		cfg.LogDir = filepath.Join(cfg.DataDir, "logs")
	}
	_ = argv
	return cfg, nil
}

// resolveAppRoot 优先认环境变量，其次从当前目录与可执行文件目录分别向上找 web/index.html。
// 开发时二进制常住在 server-go/bin/，只从可执行文件目录找会落空；只从当前目录找又会在打包后被快捷方式改变。
func resolveAppRoot() (string, error) {
	if v := strings.TrimSpace(os.Getenv("ELAINA_APP_ROOT")); v != "" {
		return filepath.Abs(v)
	}
	if wd, err := os.Getwd(); err == nil {
		if root, ok := findRootUpward(wd); ok {
			return root, nil
		}
	}
	if exe, err := os.Executable(); err == nil {
		if root, ok := findRootUpward(filepath.Dir(exe)); ok {
			return root, nil
		}
	}
	return "", fmt.Errorf("找不到应用根目录（应包含 web/index.html）：可用 ELAINA_APP_ROOT 指定")
}

func findRootUpward(dir string) (string, bool) {
	for i := 0; i < 8; i++ {
		if st, err := os.Stat(filepath.Join(dir, "web", "index.html")); err == nil && !st.IsDir() {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", false
}

func envString(name, fallback string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return fallback
}

func envPath(name, fallback string) string {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return raw
	}
	return abs
}

func splitList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.ToLower(strings.TrimSpace(part))
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func normalizeEdition(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "windows":
		return "windows"
	case "android":
		return "android"
	default:
		return "web"
	}
}

// resolveVersion 先认桌面壳传进来的 APP_VERSION，再读 package.json；打包后 package.json 可能不在，
// 两者都取不到时用 0.0.0，界面把未知版本显示成 0.0.0 比显示空更清楚。
func resolveVersion(appRoot string) string {
	if v := strings.TrimSpace(os.Getenv("APP_VERSION")); v != "" {
		return v
	}
	raw, err := os.ReadFile(filepath.Join(appRoot, "package.json"))
	if err != nil {
		return "0.0.0"
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &pkg) != nil || strings.TrimSpace(pkg.Version) == "" {
		return "0.0.0"
	}
	return strings.TrimSpace(pkg.Version)
}
