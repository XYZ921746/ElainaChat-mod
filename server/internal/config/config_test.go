package config

import (
	"path/filepath"
	"testing"
)

// 服务模式没有 web/index.html：不能走桌面那套「向上找静态根」，否则 APK 里直接启动失败。
func TestLoadServiceMode(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ELAINA_SERVICE_MODE", "1")
	t.Setenv("ELAINA_APP_ROOT", dir)
	t.Setenv("DATA_DIR", filepath.Join(dir, "elaina-data"))
	t.Setenv("ELAINA_PORT_FILE", filepath.Join(dir, "port"))
	t.Setenv("ELAINA_PLUGIN_STATE_FILE", filepath.Join(dir, "store.json"))
	t.Setenv("PORT", "")

	cfg, err := Load(nil)
	if err != nil {
		t.Fatalf("服务模式启动失败：%v", err)
	}
	if !cfg.ServiceMode || cfg.Host != "127.0.0.1" || cfg.Port != 0 {
		t.Errorf("服务模式默认值不对：%+v", cfg)
	}
	if cfg.Edition != "android" {
		t.Errorf("服务模式发行形态应为 android：%q", cfg.Edition)
	}
	if cfg.PortFile == "" || cfg.PluginStateFile == "" {
		t.Errorf("端口文件 / 插件状态文件没有从环境变量读入")
	}
}
