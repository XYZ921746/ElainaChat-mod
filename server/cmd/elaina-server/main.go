// elaina-server 是 ElainaChat 的 Go 服务端入口。它只做一件事：把配置、鉴权、证书与监听
// 接起来，然后等待退出信号。业务路由住在 internal/httpapi，避免入口文件变成第二个上帝对象。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"elainachat/server/internal/agent"
	"elainachat/server/internal/auth"
	"elainachat/server/internal/config"
	"elainachat/server/internal/fsx"
	"elainachat/server/internal/httpapi"
	"elainachat/server/internal/logx"
	"elainachat/server/internal/memoryindex"
	"elainachat/server/internal/plugin"
	"elainachat/server/internal/relay"
	"elainachat/server/internal/security"
	"elainachat/server/internal/store"
	"elainachat/server/internal/tlsutil"
)

// 本项目另一实例已在跑时的退出码：启动脚本认这个码就不再 pause（此分支没有服务可看）。
const exitAlreadyRunning = 3

func main() {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "[boot] CRITICAL: "+err.Error())
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "[boot] CRITICAL: 无法创建数据目录："+err.Error())
		os.Exit(1)
	}

	log := logx.New(cfg.LogDir, cfg.LogToFile)
	defer log.Close()

	// 配置文件样例只在不存在时写：全注释，不改变任何默认值。
	if !cfg.ServiceMode {
		if err := config.EnsureSample(config.ConfigPath(cfg.DataDir)); err != nil {
			log.Warnf("Config", "写入配置样例失败：%v", err)
		}
	}

	resetPassword := hasArg(os.Args[1:], "--reset-password")
	if resetPassword {
		// sessions.json 是旧版本的会话表，新版本不再产生它；留着只会让用户以为会话还在。
		for _, name := range []string{"auth.json", "sessions.json"} {
			_ = os.Remove(filepath.Join(cfg.DataDir, name))
		}
		if cfg.PasswordFromConfig {
			log.Warnf("Auth", "data/config.json 里写了 password：删除 auth.json 后仍会按配置写回，要重置请同时修改配置文件")
		} else {
			log.Infof("Auth", "已按 --reset-password 清除旧密码，将重新生成")
		}
	}

	authStore := auth.NewStore(cfg.DataDir, filepath.Join(cfg.WebRoot, ".local-auth.json"), log)
	isDefault, err := authStore.Ensure()
	if err != nil {
		log.Errorf("Auth", "密码记录准备失败：%v", err)
	}
	if cfg.PasswordFromConfig {
		if res := auth.ValidatePasswordStrength(cfg.Password); !res.OK {
			log.Criticalf("Auth", "data/config.json 的 password 不满足强度要求：%s", res.Message)
			os.Exit(1)
		}
		// 密码的持久形态是 config.json 本身：哈希只在内存里派生，auth.json / 遗留位置文件删除，
		// 否则改密后删掉的旧文件又会在每次启动时长回来。
		if err := authStore.SetPasswordInMemory(cfg.Password); err != nil {
			log.Criticalf("Auth", "按 data/config.json 启用密码失败：%v", err)
			os.Exit(1)
		}
		log.Infof("Auth", "访问密码由 data/config.json 管理")
	}
	isDefault = !authStore.HasAccessPassword()
	guard := auth.NewGuard()

	forceNewCert := hasArg(os.Args[1:], "--reset-cert")
	var cert *tlsutil.Info
	if !cfg.ServiceMode && cfg.HTTPS {
		cert, err = tlsutil.Ensure(cfg.CertFile, cfg.KeyFile, forceNewCert)
		if err != nil {
			log.Criticalf("Cert", "HTTPS 证书准备失败：%v", err)
			os.Exit(1)
		}
		if cert.Generated {
			log.Infof("Cert", "已生成 HTTPS 自签证书（有效期 825 天）：%s", cfg.CertFile)
		} else if cert.Custom {
			log.Infof("Cert", "使用自定义 HTTPS 证书：%s", cfg.CertFile)
		}
	} else if !cfg.ServiceMode {
		log.Infof("Cert", "HTTPS 已关闭（data/config.json 的 https=false）")
	}

	dataStore := store.New(cfg.DataDir, log)
	if moved, migrateErr := dataStore.MigrateIfNeeded(); migrateErr != nil {
		log.Warnf("Store", "数据迁移失败（服务继续启动，旧数据未受影响）：%v", migrateErr)
	} else if len(moved) > 0 {
		log.Infof("Store", "数据已迁移到分类存储：%s", strings.Join(moved, "、"))
	}
	// 手机旧版把聊天数据写在 Capacitor 的 filesDir/store.json（不是 Go 的 DATA_DIR）。
	// 这里在插件与记忆装载前把它一次性并进 Go store，之后 /api/store 与 /api/data/* 才是同一份数据。
	// prune 必须等记忆回补跑完：备份文件是已升级设备上旧记忆的唯一出处，先删就找不回来了。
	migrateLegacyMobileStore(cfg, dataStore, log)

	pluginHost := loadPlugins(cfg, log, dataStore)
	relayHandler := relay.New(log)
	// 监听所有网卡是用户主动开放应用：此时中转不再按来源拦内网服务商。
	relayHandler.SetTrustAllClients(cfg.Host == "" || cfg.Host == "0.0.0.0" || cfg.Host == "::")
	agentHandler := agent.New(cfg.AppRoot, cfg.DataDir, dataStore, log)
	memIndex := openMemoryIndex(cfg, log)
	if memIndex != nil {
		if memIndex.Degraded() {
			recoverMemoryAfterRebuild(dataStore, memIndex, log)
		}
		migrateLegacyMemoryCore(dataStore, memIndex, log)
		recoverLegacyMobileMemory(cfg, memIndex, log)
	}
	pruneLegacyMobileBackups(cfg, log)
	server := httpapi.New(cfg, log, authStore, guard, cert, dataStore, pluginHost, relayHandler, agentHandler)
	server.SetConfigPasswordManaged(cfg.PasswordFromConfig)
	server.SetConfigPath(config.ConfigPath(cfg.DataDir))
	if memIndex != nil {
		server.SetMemoryIndex(memIndex)
		defer closeMemoryIndex(memIndex)
	}
	shutdownCh := make(chan struct{}, 1)
	server.SetShutdown(func() {
		select {
		case shutdownCh <- struct{}{}:
		default:
		}
	})

	// 端口文件是上一次运行的残留时，Java 服务进程会照着死端口连到超时：先删再监听。
	if cfg.PortFile != "" {
		if err := os.Remove(cfg.PortFile); err != nil && !os.IsNotExist(err) {
			log.Warnf("Core", "清理残留端口文件失败：%v", err)
		}
	}

	var port int
	var mux *httpapi.Mux
	alreadyRunning := false
	if cfg.ServiceMode {
		// 手机端：端口交给内核挑（0），拿到真实端口后写 PortFile 给 Java 服务进程。
		mux, err = httpapi.ListenAndServe(cfg, log, authStore, server, nil, 0)
		if err != nil {
			log.Criticalf("Core", "CRITICAL: service mode failed to listen: %v", err)
			closeMemoryIndex(memIndex)
			os.Exit(1)
		}
		port = mux.Port()
	} else {
		port, mux, alreadyRunning = listenOnConfiguredPort(cfg, log, authStore, server, cert)
	}
	if alreadyRunning {
		openBrowser("http://127.0.0.1:" + strconv.Itoa(port))
		log.Infof("Core", "已有实例在 %d 端口运行，已打开浏览器并退出", port)
		closeMemoryIndex(memIndex)
		os.Exit(exitAlreadyRunning)
	}
	if mux == nil {
		closeMemoryIndex(memIndex)
		os.Exit(1)
	}
	server.SetPort(port)
	if cfg.PortFile != "" {
		if writeErr := writePortFileAtomic(cfg.PortFile, port); writeErr != nil {
			log.Warnf("Core", "写入端口文件失败（Java 侧将拿不到端口）：%v", writeErr)
		}
	}

	logListening(cfg, log, port, cert != nil, authStore.HasAccessPassword())
	if !cfg.ServiceMode {
		openBrowser("http://127.0.0.1:" + strconv.Itoa(port))
	}

	if isDefault {
		// 无密码不等于"设备连不上"：host 非回环时设备已经能进，闸门只在本机免密判定里。
		log.Infof("Auth", "LAN access password: not set (any device that can reach this port is let straight in; set one in Settings → Advanced)")
	} else {
		log.Infof("Auth", "LAN access password: user-configured")
	}
	log.Infof("Core", "就绪。日志可在应用内「设置 → 日志」按级别/模块筛选查看。")

	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// 会话不再有内存表可清：过期由 token 自身的 exp 判定，这里只需清理登录失败记录。
				guard.Prune()
			case <-done:
				return
			}
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-shutdownCh:
	}
	close(done)

	// 先让 SSE 等长连接收尾，再关监听与 http.Server；否则 Shutdown 会等满下面的超时。
	server.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = mux.Shutdown(ctx)
	// 端口随进程一起失效，文件必须跟着走：留着它，下一次启动前的窗口里
	// Java 侧可能连到这个已经没人监听的端口。
	if cfg.PortFile != "" {
		_ = os.Remove(cfg.PortFile)
	}
}

// writePortFileAtomic 用临时文件 + 改名落端口：Java 侧轮询这个文件，
// 读到半截内容就会拿一个坏端口。数据先 fsync 再改名，掉电时不会出现
// 「端口文件已就位而内容是空/半截」的窗口。
func writePortFileAtomic(path string, port int) error {
	return fsx.WriteFileAtomic(path, []byte(strconv.Itoa(port)), 0o600)
}

// listenOnConfiguredPort 只绑配置里的那一个端口。端口是用户写在 data/config.json 的约定：
// 自动往上找会让「我改了端口怎么还连不上」和检查脚本的固定端口断言都失效。
// 绑不上时先认一认占用者是不是本项目实例——重复双击不该起第二个服务；
// 是别的程序就明说端口被占，并给出改端口的位置。
func listenOnConfiguredPort(cfg *config.Config, log *logx.Logger, authStore *auth.Store, handler http.Handler, cert *tlsutil.Info) (int, *httpapi.Mux, bool) {
	mux, err := httpapi.ListenAndServe(cfg, log, authStore, handler, cert, cfg.Port)
	if err == nil {
		// port 填 0 时由系统分配，真实端口只有监听之后才知道。
		return mux.Port(), mux, false
	}
	if cfg.Port > 0 && isOurInstance(cfg.Port) {
		return cfg.Port, nil, true
	}
	log.Criticalf("Core", "CRITICAL: 端口 %d 已被其它程序占用，服务没有启动\n"+
		"  cause: another process is bound to this port\n"+
		"  fix: 关掉占用它的程序（netstat -ano | findstr :%d 可查 PID），\n"+
		"       或改 data/config.json 里的 port 换一个端口后重试", cfg.Port, cfg.Port)
	return cfg.Port, nil, false
}

// isOurInstance 的判据是 /api/server-info 的应答形状，只连回环地址。
// 别的软件不会恰好回 { ok:true, httpPort:<数字> }。
func isOurInstance(port int) bool {
	client := &http.Client{Timeout: 700 * time.Millisecond}
	resp, err := client.Get("http://127.0.0.1:" + strconv.Itoa(port) + "/api/server-info")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var info struct {
		OK       bool `json:"ok"`
		HTTPPort *int `json:"httpPort"`
	}
	if json.NewDecoder(resp.Body).Decode(&info) != nil {
		return false
	}
	return info.OK && info.HTTPPort != nil
}

func logListening(cfg *config.Config, log *logx.Logger, port int, hasHTTPS, hasPassword bool) {
	urls := []string{"http://127.0.0.1:" + strconv.Itoa(port)}
	nonLoopback := cfg.Host == "0.0.0.0" || cfg.Host == "::"
	if nonLoopback {
		// 无密码时同样要列出局域网地址：此时没有任何闸门，设备已经能连进来，
		// 只在有密码时才打印等于让用户以为"没提示就是没开放"。
		for _, ip := range security.LocalIPv4List() {
			urls = append(urls, "http://"+ip+":"+strconv.Itoa(port))
		}
	}
	suffix := ""
	if hasHTTPS {
		suffix = " (HTTP+HTTPS on the same port)"
	}
	log.Infof("Core", "listening on %s%s", strings.Join(urls, ", "), suffix)
	if nonLoopback && !hasPassword {
		// 这不是提醒而是实情：无密码 + 对外监听时局域网里任何设备都能直接进来，
		// 没有登录页可挡 —— 包括 Agent 执行与文件读写。
		log.Warnf("Auth", "未设置访问密码且监听 %s：局域网内任何设备都能直接访问（含 Agent 执行与文件读写）。可在 设置 → 高级 设置密码，或把 host 改回 127.0.0.1", cfg.Host)
	}
}

func hasArg(argv []string, want string) bool {
	for _, a := range argv {
		if a == want {
			return true
		}
	}
	return false
}

// loadPlugins 只读一次启用状态：服务端读不到浏览器的 localStorage，
// 也不该长着「配置存在哪」的知识；调用方把键值表递进来即可。
// migrateLegacyMobileStore 把旧 APK 的 Capacitor Store（flat JSON）并进 Go store。
// 只在 ELAINA_PLUGIN_STATE_FILE 被 Java 服务进程传入时生效（桌面为空）。
// 成功标记写在 <DATA_DIR>/main/.mobile-store-migrated；旧文件改名为 .migrated-*，
// 既保留回滚材料，也避免原生 Store 后端再次读到它。
func migrateLegacyMobileStore(cfg *config.Config, dataStore *store.Store, log *logx.Logger) {
	legacy := strings.TrimSpace(cfg.PluginStateFile)
	if legacy == "" {
		return
	}
	marker := filepath.Join(cfg.DataDir, "main", ".mobile-store-migrated")
	if _, err := os.Stat(marker); err == nil {
		renameLegacyMobileStore(legacy, log)
		return
	}
	raw, err := os.ReadFile(legacy)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warnf("Store", "读取手机旧 Store 失败（本次不迁移）：%v", err)
		}
		return
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		log.Warnf("Store", "手机旧 Store 不是合法 JSON（本次不迁移）：%v", err)
		return
	}
	current, _ := dataStore.Load()
	patch := make(map[string]*string, len(parsed))
	for k, v := range parsed {
		s, ok := v.(string)
		if !ok || legacyMobileStoreSkipKey(k) {
			continue
		}
		// 记忆键在进 Go store 之前先按六类目形状校验：坏 JSON 不能混进补丁 ——
		// writeMemory 解析失败会让整次 MergeAndSave 回滚，会话/设置也跟着迁不成。
		if k == store.MemoryKey {
			if _, parseErr := memoryindex.ParseCore([]byte(s)); parseErr != nil {
				log.Warnf("Store", "手机旧 Store 里的记忆数据不是合法六类目 JSON，跳过记忆键（其余键继续迁移）：%v", parseErr)
				continue
			}
		}
		// 只补空：Go store 已经有非空值时保留新值，旧文件不能把它盖回去。
		if cur, exists := current[k]; exists && strings.TrimSpace(cur) != "" && cur != "{}" && cur != "[]" {
			continue
		}
		value := s
		patch[k] = &value
	}
	if len(patch) > 0 {
		if _, err := dataStore.MergeAndSave(patch); err != nil {
			log.Errorf("Store", "手机旧 Store 迁移失败（下次启动重试）：%v", err)
			return
		}
		log.Infof("Store", "已把手机旧 Store 里缺失的 %d 项补进 Go 数据目录", len(patch))
		// 旧设置包里可能内嵌 Key 字段：导入完立刻转进密钥表，密钥升级别等页面打开。
		if _, err := dataStore.MigrateEmbeddedLegacySecrets(); err != nil {
			log.Warnf("Store", "设置包内嵌 Key 转存密钥表失败（字段保留，下次重试）：%v", err)
		}
		// 首次启动时服务可能还没就绪：把“合并后的当前快照”写成手机 Store 的只读缓存，
		// 页面在 8 秒等待里也能先把数据画出来（下一次成功 GET/POST 会覆盖它）。
		// 记忆键不能进快照：迁移刚把它落成 main/memory/ 类目文件，权威即将转入 SQLite，
		// 设备上多留一份整包记忆既占空间，又会变成前端缓存里的第二份权威。
		cachePath := filepath.Join(filepath.Dir(legacy), "store.cache.json")
		if merged, loadErr := dataStore.Load(); loadErr == nil {
			delete(merged, store.MemoryKey)
			if snapshot, marshalErr := json.Marshal(merged); marshalErr == nil {
				if err := os.WriteFile(cachePath, snapshot, 0o600); err != nil {
					log.Warnf("Store", "写手机 Store 缓存失败（不影响已迁移数据）：%v", err)
				}
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		log.Warnf("Store", "创建手机 Store 迁移标记目录失败（下次启动会再次导入）：%v", err)
	} else if err := os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o600); err != nil {
		log.Warnf("Store", "写入手机 Store 迁移标记失败（下次启动会再次导入）：%v", err)
	}
	renameLegacyMobileStore(legacy, log)
}

// obsoleteMobileKey 是旧 APK 里不该喂给插件状态面的键：插件装载只认开关键，
// 记忆整包、向量索引、单卡镜像与历史收藏在这里都是无关负载。
// 数据面的排除规则见 legacyMobileStoreSkipKey —— 两个面排除的键不一样，别合并成一个函数。
func obsoleteMobileKey(key string) bool {
	switch key {
	case store.MemoryKey, store.CharacterActiveKey, "elaina_memory_vectors", "elaina_open_liked_quotes":
		return true
	}
	return strings.HasPrefix(key, "elaina_plugin_failed_")
}

// legacyMobileStoreSkipKey 是手机旧 Store 迁进 Go store 的数据面排除表。
// 记忆键**必须放行**：它是旧 APK 上六类目记忆的唯一权威，放行后由 writeClassified
// 落成 main/memory/ 类目文件，migrateLegacyMemoryCore 才有东西可搬 —— 排除它等于
// 给升级设备的记忆留一条"排除即丢失、且无任何回补路径"的断链（插件状态面的排除
// 见 obsoleteMobileKey，两个面排除的原因不同，不能共用）。
func legacyMobileStoreSkipKey(key string) bool {
	switch key {
	case store.CharacterActiveKey, "elaina_memory_vectors", "elaina_open_liked_quotes":
		return true
	}
	return strings.HasPrefix(key, "elaina_plugin_failed_")
}

// recoverLegacyMobileMemory 给「数据面迁移跳过了记忆键」的设备找回记忆。
// 那类设备上旧 Store 已改名 store.json.migrated-<时间戳>、迁移标记已落，重新迁移
// 不会再读它 —— 记忆只剩备份文件里那一份，而备份 30 天后会被 pruneLegacyMobileBackups
// 回收。这里一次性扫备份把记忆搬进 SQLite，之后落独立标记，永不重复：
// 重复回灌会把用户主动删掉的记忆按旧快照复活。
func recoverLegacyMobileMemory(cfg *config.Config, index *memoryindex.Store, log *logx.Logger) {
	if index == nil || strings.TrimSpace(cfg.PluginStateFile) == "" {
		return
	}
	marker := filepath.Join(cfg.DataDir, "main", ".mobile-memory-recovered")
	if _, err := os.Stat(marker); err == nil {
		return
	}
	// 库里已有记忆就不分辨新旧了：宁可不补，也不把用户新写的条目拿旧快照覆盖。
	// 标记照落 —— 这台设备已经被扫过一遍，往后也不再是回补的对象。
	if count, countErr := index.CountItems(); countErr != nil || count > 0 {
		if writeErr := os.MkdirAll(filepath.Dir(marker), 0o755); writeErr == nil {
			_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o600)
		}
		return
	}
	dir := filepath.Dir(cfg.PluginStateFile)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	names := make([]string, 0, 4)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), "store.json.migrated-") {
			names = append(names, entry.Name())
		}
	}
	// 备份名带时间戳，字符串序即时间序：从新到旧，取第一份带记忆的 —— 新备份比旧备份更接近升级时刻。
	for i := len(names) - 1; i >= 0; i-- {
		raw, readErr := os.ReadFile(filepath.Join(dir, names[i]))
		if readErr != nil {
			continue
		}
		var parsed map[string]any
		if json.Unmarshal(raw, &parsed) != nil {
			continue
		}
		rawCore, ok := parsed[store.MemoryKey].(string)
		if !ok || strings.TrimSpace(rawCore) == "" {
			continue
		}
		res, importErr := index.ImportLegacyCore([]byte(rawCore), true, "mobile-backup-recovery")
		if importErr != nil {
			// 导入失败不落标记：数据还在备份文件里，下次启动重试。
			log.Warnf("Memory", "从手机迁移备份回补记忆失败（下次启动重试）：%v", importErr)
			return
		}
		log.Infof("Memory", "已从手机迁移备份找回 %d 条记忆（跳过 %d 条坏数据）", res.Upserted, res.Skipped)
		break
	}
	if writeErr := os.MkdirAll(filepath.Dir(marker), 0o755); writeErr != nil {
		log.Warnf("Memory", "写入记忆回补标记失败（下次启动会重试回补）：%v", writeErr)
		return
	}
	_ = os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339Nano)), 0o600)
}

func renameLegacyMobileStore(path string, log *logx.Logger) {
	if _, err := os.Stat(path); err != nil {
		return
	}
	target := path + ".migrated-" + time.Now().UTC().Format("20060102-150405")
	if err := os.Rename(path, target); err != nil {
		log.Warnf("Store", "手机旧 Store 改名失败（已迁数据不受影响）：%v", err)
		return
	}
	log.Infof("Store", "手机旧 Store 已保留为 %s", target)
}

// legacyBackupRetention 是迁移/改名留下的备份的保留期。
// 这些文件是「迁完还能回滚」的材料，不是归档：迁完再放很久只会白占手机存储
// （旧 Store 里可能内嵌几 MB 的参考音频，一份就 3~4MB），过了期限就该回收。
const legacyBackupRetention = 30 * 24 * time.Hour

// pruneLegacyMobileBackups 清掉 filesDir 下过期的迁移备份：`store.json.migrated-<时间戳>`
// 与 `live2d-models.bak-<日期>`。
//
// 只在手机布局（PluginStateFile 指向 filesDir/store.json）下跑：桌面没有这套文件，
// 扫用户自己的目录既无意义也有误删风险。
//
// 判据一律取文件/目录自身的修改时间，不解析文件名里的时间戳 —— 两套命名格式不同
// （一个到秒、一个到日），解析失败就静默跳过的分支会把该删的永久留下。
func pruneLegacyMobileBackups(cfg *config.Config, log *logx.Logger) {
	legacy := strings.TrimSpace(cfg.PluginStateFile)
	if legacy == "" {
		return
	}
	dir := filepath.Dir(legacy)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-legacyBackupRetention)
	removed := 0
	for _, entry := range entries {
		name := entry.Name()
		isMigrated := strings.HasPrefix(name, "store.json.migrated-")
		isBak := strings.HasPrefix(name, "live2d-models.bak-")
		if !isMigrated && !isBak {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		target := filepath.Join(dir, name)
		if entry.IsDir() {
			if err := os.RemoveAll(target); err != nil {
				log.Warnf("Store", "清理过期备份目录失败：%s（%v）", name, err)
				continue
			}
		} else if err := os.Remove(target); err != nil {
			log.Warnf("Store", "清理过期备份文件失败：%s（%v）", name, err)
			continue
		}
		removed++
	}
	if removed > 0 {
		log.Infof("Store", "已清理 %d 份过期的迁移备份（保留期 %d 天）", removed, int(legacyBackupRetention.Hours()/24))
	}
}

func loadPlugins(cfg *config.Config, log *logx.Logger, dataStore *store.Store) *plugin.Host {
	modules, err := plugin.Scan(cfg.ModsDir)
	if err != nil {
		log.Warnf("Mod", "扫描插件目录失败：%v", err)
		return plugin.New(cfg.ModsDir, log)
	}
	if err := plugin.WriteIndex(cfg.ModsDir, modules); err != nil {
		log.Warnf("Mod", "写入插件清单失败：%v", err)
	}

	// 手机旧版把启用状态放在 Capacitor 的 filesDir/store.json；迁移后该文件会被改名，
	// 之后统一从 Go store 读。标记存在时即使改名失败也不再读旧文件，否则旧的整份状态会盖住新值。
	state := map[string]string{}
	stateLoaded := false
	mobileMarker := filepath.Join(cfg.DataDir, "main", ".mobile-store-migrated")
	if cfg.PluginStateFile != "" {
		if _, markerErr := os.Stat(mobileMarker); markerErr == nil {
			log.Infof("Mod", "手机 Store 已迁移，插件状态只从 Go store 读取")
		} else if raw, readErr := os.ReadFile(cfg.PluginStateFile); readErr == nil {
			var parsed map[string]any
			if json.Unmarshal(raw, &parsed) == nil {
				for k, v := range parsed {
					if s, ok := v.(string); ok && !obsoleteMobileKey(k) {
						state[k] = s
					}
				}
				stateLoaded = true
			}
		}
	}
	if !stateLoaded {
		state, _ = dataStore.Load()
	}
	isEnabled := func(m plugin.Module) bool {
		if state["elaina_plugins_enabled"] == "0" {
			return false
		}
		switch state["elaina_plugin_"+m.ID] {
		case "1":
			return true
		case "0":
			return false
		}
		return m.DefaultEnabled
	}

	host := plugin.New(cfg.ModsDir, log)
	status := host.LoadAll(modules, isEnabled)
	loaded := 0
	for _, result := range status.Mods {
		if result.OK {
			loaded++
		}
	}
	log.Infof("Mod", "插件服务端半边：已装载 %d 个（扫描到 %d 个插件目录）", loaded, len(modules))
	return host
}

// openBrowser 只在 OPEN_BROWSER=1 时打开：服务端也是几十个检查用例的子进程，
// 无条件弹窗会炸出几十个标签页。失败只警告，不影响服务。
func openBrowser(url string) {
	if os.Getenv("OPEN_BROWSER") != "1" {
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// start 是 cmd 内建命令；第一个引号参数是窗口标题，不能省（否则带引号的 URL 会被当成标题）。
		cmd = exec.Command("cmd", "/c", "start", "", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "[boot] 无法自动打开浏览器（"+err.Error()+"）—— 请手动访问 "+url)
		return
	}
	_ = cmd.Process.Release()
}

// 记忆库的落盘位置。M2b 起它是记忆权威，必须住在 data/main/（派生缓存目录 data/cache/
// 的语义是「可随时整删、导入后清空」，权威放那里等于用户导入一次备份就丢掉全部记忆）。
func memoryDBPath(cfg *config.Config) string {
	return filepath.Join(cfg.DataDir, "main", "memory", "index.db")
}

// relocateMemoryDB 把 M1/M2a 时代留在 data/cache/ 的库搬到新位置。
// 只在目标不存在时搬：新库里已经有数据的优先。旧库是派生数据，残留无害。
func relocateMemoryDB(cfg *config.Config, log *logx.Logger) string {
	newPath := memoryDBPath(cfg)
	oldPath := filepath.Join(cfg.DataDir, "cache", "memory_index.db")
	if _, err := os.Stat(newPath); err == nil {
		return newPath
	}
	if _, err := os.Stat(oldPath); err != nil {
		return newPath
	}
	if err := os.MkdirAll(filepath.Dir(newPath), 0o755); err != nil {
		log.Warnf("Memory", "创建记忆目录失败，索引留在旧位置：%v", err)
		return oldPath
	}
	var moved []string
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(oldPath + suffix); err != nil {
			continue
		}
		if renameErr := os.Rename(oldPath+suffix, newPath+suffix); renameErr != nil {
			// 整库搬迁必须同进同退：主库搬了、WAL 没搬会丢最近的写入；
			// 已搬的文件回滚，让程序继续用旧位置，避免“两个位置各有一半”。
			for _, done := range moved {
				if backErr := os.Rename(newPath+done, oldPath+done); backErr != nil {
					log.Warnf("Memory", "记忆库回滚失败（%s）：%v", done, backErr)
				}
			}
			log.Warnf("Memory", "记忆库搬迁失败（%s），继续用旧位置：%v", oldPath, renameErr)
			return oldPath
		}
		moved = append(moved, suffix)
	}
	log.Infof("Memory", "记忆库已从 data/cache/ 搬到 data/main/memory/（升为权威）")
	return newPath
}

// openMemoryIndex 打开记忆库。失败不影响服务启动：本会话记忆面 501（页面改动只留在
// 页面内存），重启重试；库损坏重建的回灌走 recoverMemoryAfterRebuild。
func openMemoryIndex(cfg *config.Config, log *logx.Logger) *memoryindex.Store {
	path := relocateMemoryDB(cfg, log)
	index, err := memoryindex.Open(path, log)
	if err != nil {
		log.Warnf("Memory", "SQLite 记忆库不可用，本会话记忆读写面关闭：%v", err)
		return nil
	}
	log.Infof("Memory", "SQLite 记忆库：%s", path)
	return index
}

// recoverMemoryAfterRebuild 在权威库损坏重建（新库为空且留证）后，尝试从迁移备份回灌。
// 迁移成功时六类目 JSON 只挪进备份目录没有删，那是重建后唯一完整的服务端副本；
// 回灌不成（没有备份 / 备份损坏）时 degraded 保持置位，GET /core 会拒绝空库，
// 页面本地数据不会被子覆盖。
func recoverMemoryAfterRebuild(dataStore *store.Store, index *memoryindex.Store, log *logx.Logger) {
	if dataStore == nil || index == nil {
		return
	}
	raw, ok, err := dataStore.LegacyMemoryBackupJSON()
	if err != nil || !ok {
		log.Warnf("Memory", "记忆库损坏后重建为空，且没有可回灌的迁移备份；页面本地数据未受影响，可在「我的数据」导入备份恢复")
		return
	}
	res, err := index.ImportLegacyCore([]byte(raw), true, "rebuild-recovery")
	if err != nil {
		log.Warnf("Memory", "从迁移备份回灌记忆失败：%v", err)
		return
	}
	log.Infof("Memory", "记忆库损坏重建后已从迁移备份自动恢复 %d 条记忆", res.Upserted)
}

// migrateLegacyMemoryCore 把 Store 的六类目 JSON 一次性搬进 SQLite；
// 迁移成功后旧文件挪进备份目录留底（见 store.BackupLegacyMemoryTo）。
//
// 幂等靠 schema_meta 里的标记。标记已存在但磁盘上又出现了类目文件（上次清理失败
// 等残留）时按 replace 回灌：类目 JSON 是整份的策展清单（promise/preference/plan
// 是「整类目替换」写出来的），按行合并会让模型刻意丢掉的旧字符串永远残留。
func migrateLegacyMemoryCore(dataStore *store.Store, index *memoryindex.Store, log *logx.Logger) {
	if dataStore == nil || index == nil {
		return
	}
	migrated, markerErr := index.LegacyMigrated()
	if markerErr != nil {
		// 标记读不到时不能贸然 replace：旧 JSON 可能比库里新，覆盖会丢刚整理出来的记忆。
		log.Warnf("Memory", "读取记忆迁移标记失败（本次跳过迁移）：%v", markerErr)
		return
	}
	if migrated {
		// 标记已置位后再出现的顶层类目文件只可能是残留（重命名失败/旧客户端写入），
		// 不能再导入：用户明确删掉的记忆会被旧快照复活。恢复走完整 legacy-backup。
		raw, exists, err := dataStore.LegacyMemoryJSON()
		if err != nil {
			log.Warnf("Memory", "读取迁移后残留的记忆文件失败：%v", err)
			return
		}
		if !exists || raw == "" {
			return
		}
		if _, err := dataStore.BackupLegacyMemoryTo(); err != nil {
			log.Warnf("Memory", "迁移后残留的记忆文件归档失败（保留原文件，不导入）：%v", err)
			return
		}
		log.Infof("Memory", "迁移标记已存在，顶层残留记忆文件已归档，未再导入")
		return
	}
	raw, exists, err := dataStore.LegacyMemoryJSON()
	if err != nil {
		log.Warnf("Memory", "读取旧记忆数据失败（本次跳过迁移）：%v", err)
		return
	}
	if !exists {
		// 没有旧数据要搬：落标记（幂等），避免将来误判。
		if err := index.MarkLegacyMigrated(); err != nil {
			log.Warnf("Memory", "写入记忆迁移标记失败：%v", err)
		}
		return
	}
	res, err := index.ImportLegacyCore([]byte(raw), true, "legacy-migration")
	if err != nil {
		// 迁移失败绝不删旧文件：旧 JSON 还是唯一完整副本，用户数据一条都不能丢。
		log.Warnf("Memory", "记忆迁移失败（旧数据保留在 Store，服务继续）：%v", err)
		return
	}
	finishLegacyCoreImport(index, dataStore.BackupLegacyMemoryTo, log, res)
}

// finishLegacyCoreImport 处理导入成功后的收尾：备份留底 + 落迁移标记。
// 备份失败不能拦住落标记：SQLite 从导入成功那一刻起就是唯一权威，若因备份失败不落标记，
// 下次启动会把旧 JSON 整份重灌进库，两次启动之间经 /api/memory 做过的编辑会被覆盖。
// 备份失败的残留文件走「标记置位后只归档不导入」的既有路径，留底在归档时完成。
func finishLegacyCoreImport(index *memoryindex.Store, backup func() (string, error), log *logx.Logger, res memoryindex.ImportResult) {
	backupOK := true
	if _, err := backup(); err != nil {
		backupOK = false
		log.Warnf("Memory", "整理旧记忆文件失败（数据已在 SQLite，残留文件下次启动归档，不再重灌）：%v", err)
	}
	if err := index.MarkLegacyMigrated(); err != nil {
		log.Warnf("Memory", "写入记忆迁移标记失败（下次启动会重试迁移）：%v", err)
		return
	}
	if backupOK {
		log.Infof("Memory", "记忆已从 Store 迁入 SQLite：%d 条（跳过 %d 条坏数据），旧类目文件已挪进备份目录", res.Upserted, res.Skipped)
	} else {
		log.Infof("Memory", "记忆已从 Store 迁入 SQLite：%d 条（跳过 %d 条坏数据），旧类目文件留待下次启动归档", res.Upserted, res.Skipped)
	}
}

func closeMemoryIndex(index *memoryindex.Store) {
	if index != nil {
		index.Close()
	}
}
