# server

Go 版服务端，**电脑版与安卓版运行时本体**：启动脚本、Windows 外壳与打包都以
`server/bin/elaina-server.exe` 为准。服务端是静态编译的单文件；插件服务端半边
按「收窄 ctx 契约」实现（见 `开发文档.md` 的插件章节）。仓库里只有这一套服务端实现；
服务端行为回归由 `go test ./...` 与 `scripts/` 下以本目录二进制为夹具的检查脚本覆盖。

## 已实现

- 同端口 HTTP/HTTPS 复用（首字节分流）与自签证书（Go 标准库生成，不依赖 openssl）；只有这一个监听端口，不再开 `port+1` 兼容入口
- 端口 / 监听地址 / HTTPS 开关 / 自定义证书走`data/config.json`（环境变量优先）
- 静态资源（`web/` 与 `mods/`）、路径穿越与隐藏文件拦截
- 访问密码、会话、改密、防爆破、密码强度校验（≥8 位，数字 + 其他字符，不强制大小写）；
  改密后密码持久形态是 `data/config.json`（旧 `data/auth.json` 向下兼容，config 没写 password 时照常生效）；
  改密是串行事务（写配置 → 换内存认证 → 吊销会话 → 发新会话），配置先落盘而后续失败时恢复快照，
  不会出现「接口报错但密码已换」或内存与磁盘密码分叉
- `/api/server-info`、`/api/ping`、`/api/auth/*`、`/api/client-log`
- `/api/store` 与 `/api/store/stream`（SSE）；磁盘布局沿用既有 `data/store.json` 分片格式，含旧数据迁移。
  SQLite 记忆可用时，`GET /api/store` 不再返回 `elaina_open_memory_core`（旧键不能成为第二份权威）
- `GET|POST /api/memory/core`：**记忆权威**（M2b）。六类目正文存 SQLite（`data/main/memory/index.db`），
  GET 还原 canonical 形状（条目带 id 与全部附加字段），POST 整类目替换 + `dropIds` 显式删除，
  事务内同步 FTS 全文索引并写事件；变更经 store SSE 的 `memory-change` 事件通知其它设备。
  启动时把旧 Store 类目 JSON 一次性迁进来并归档到 `main/memory/legacy-backup-*`（幂等标记；
  标记置位后顶层残留文件只归档、不再导入，避免复活用户已删除的记忆）
- `/api/memory/items/{upsert,delete,ids}`、`/api/memory/search`、`/api/memory/timeline`：记忆条目的
  行级读写与 FTS5 全文检索（契约见 `开发文档.md` 表 A28）
- `/api/memory/index/{status,upsert,begin,commit,delete,reset}` 与 `GET /api/memory/index`：向量索引
  （派生缓存，按 `(指纹, id)` 复合键分桶，可随时重建；不进备份）。`begin` 无条件接管同指纹构建并清空旧行，
  `commit` 校验 buildId；未 commit 的桶读出为空，旧 build 的写入/提交返回 409
- `/api/data/export|import|info`：完整备份（数据 + 插件 + 技能）、v1/v2/v3/v4 导入、merge / replace；
  v4 起记忆以 `data/memory-index/items.json` 逻辑导出，`.db` 不进备份，旧备份的记忆类目 JSON 导入时自动转换。
  导入前按 zip 条目做严格校验：已识别的设置 / 集合索引 / 索引引用条目 / 记忆记录损坏即整体 400，
  不再静默跳过（否则 replace 会把损坏备份当成「空集合」清掉本地数据）；合法的空集合仍可导入
- 插件与技能：`/api/plugins`（列表 / 安装 / 删除 / README / 打开目录）、`/api/skills`（列表 / 安装 / 删除 / 内容）
- 插件宿主：扫描 `mods/`、生成 `/mods/index.json`、装载 `manifest.server.entry`、
  分发插件路由与静态目录；`ctx` 契约见 `开发文档.md` 表 A23（`register(ctx)`、禁止 import、
  能力校验、`ctx.fs` / `ctx.zip` / `ctx.exec`）
- `/api/relay` 本地中转：SSRF 防护（含拨号时按 IP 复查）、流式透传、TLS 1.2 回退
- `/api/logs/tail` 与 `/api/logs/settings`：内存日志缓冲、级别 / 模块 / 关键词过滤、运行期调级别与追踪开关
- `/api/agent/roots|ls|read|write|delete|exec`：四档权限（off / strict / auto / full）、路径别名、删除守卫、危险命令判定与超时/截断；
  数据目录 / 程序文件的保护边界按**真实路径**判定（Windows 目录联接用句柄级解析），经链接包装的受保护路径读写、删除与命令工作目录都会被拒绝
- `/api/agent/activity`：前台窗口与进程（PowerShell + 缓存）
- `/api/agent/browser` 与 `browser/status`：Chrome / Edge CDP（临时 profile、只绑回环、URL 白名单、空闲关闭）
- `/api/mcp/tools|call|test|stop|status`：stdio + Streamable HTTP；请求取消只结束本次等待
  （stdio 子进程跟着客户端生命周期走，不随单个请求退出），`BeginShutdown` 会停掉全部客户端并
  结束远程会话 / 杀掉本地子进程
- `/api/data/lan/enable|export|pull`：局域网共享（5 分钟开关、6 位验证码、连错 5 次换码、`host=127.0.0.1` 时临时监听、私网 SSRF 校验、代登录拉取；老客户端仍可填访问密码）
- `/api/app/update`：GitHub Release 检测（缓存、错误归一化、公共 DNS 直连、hosts 证据）
- 只绑配置里的那一个端口，被占用即报错退出（不静默换端口）；占用者是「本项目实例已在跑」时按复用处理（退出码 3）。
  桌面端**先预留监听再迁移数据**：重复实例在改认证 / 迁移 Store / 打开 SQLite 之前就退出
- 安卓服务模式（`ELAINA_SERVICE_MODE=1`）：只绑回环、端口交内核分配并写 `ELAINA_PORT_FILE`、
  Origin 白名单 `https://localhost` + CORS、`/api/ping` / `/api/mods/status` / `/api/shutdown`；
  完整路由表照常可用（`/api/store`、`/api/data/*`、`/api/data/lan/*`、`/api/memory/*` 等），
  页面侧只按 `NODE_FIXED_PREFIXES` 转发一部分，store/data/LAN 由适配层用绝对 `__nodeBase` 直连

## 构建与运行

```bash
cd server
go build -trimpath -ldflags "-s -w" -o bin/elaina-server.exe ./cmd/elaina-server
```

```bash
PORT=4199 DATA_DIR=/tmp/elaina-data LOG_DIR=/tmp/elaina-logs ./bin/elaina-server.exe
```

环境变量：`PORT` / `HOST` / `DATA_DIR` / `LOG_DIR` / `MODS_DIR` / `SKILLS_DIR` /
`OPEN_BROWSER` / `ALLOWED_HOSTS` / `APP_VERSION` / `ELAINA_EDITION` / `ELAINA_BROWSER` /
`ELAINA_BROWSER_HEADLESS` / `ELAINA_UPDATE_REPO` / `ELAINA_HTTPS` / `ELAINA_CERT_FILE` /
`ELAINA_KEY_FILE` / `ELAINA_CONFIG_FILE` / `LOG_LEVEL`（落盘级别）/ `LOG_CONSOLE`（控制台级别）。
默认只监听 `127.0.0.1`。`data/config.json` 可配置 `port`（默认 3999，填 0 由系统分配）/
`host`（改 `0.0.0.0` 才允许局域网访问）/ `https` / `cert` / `key` / `password` / `allowed_hosts`；
环境变量优先级更高。端口只绑配置里的那一个：被别的程序占用即报错退出，不会静默换端口。`password` 非空时它就是权威密码：启动时派生哈希、删除 `auth.json`；
**界面改密同样写入 config.json 并删除旧密码文件** —— 密码的持久形态就是 config.json
（明文，注意 data/ 备份安全）。向下兼容：config.json 没写 `password` 时，旧版
`data/auth.json`（scrypt 哈希或更早的明文默认密码记录）照常生效，改密前老密码继续可用。
密码规则为至少 8 位、同时包含数字与其他字符（字母或符号），不强制大小写；
自定义证书放 `data/cert.pem` + `key.pem` 即可，或在配置里指定路径（相对路径以 config/ 为基准）；
应用不会覆盖用户自己的证书。

记忆库使用 `github.com/ncruces/go-sqlite3`（纯 Go WASM SQLite），**不要换回 `modernc.org/sqlite`**：
后者在 Android x86_64 上打开库时会走被 seccomp 拒绝的 `lstat`（`SIGSYS`，进程直接崩）。
M2b 起它住在 `data/main/memory/index.db`，是**记忆正文的唯一权威**：启动时会把旧 Store
类目 JSON（`data/main/memory/*.json`）一次性迁进来并归档到 `legacy-backup-*`（幂等标记，
迁移失败保留旧文件）。标记置位后顶层再次出现的类目文件只归档、不再导入；重建恢复合并所有
备份目录，而不是只信最新一个。库内向量表仍是派生数据，可重建；`.db` 文件不进备份（备份里的
记忆是逻辑导出），也不参与多设备同步——多设备都连这台服务端，权威天然只有这一份。
schema 版本由 `PRAGMA user_version` 管理（当前 v4；向量表为 `(fingerprint, id)` 复合主键，
另有 `vector_buckets` 记录桶维度 / ready / build_id）。
记忆库打不开（损坏 / 权限）时服务照常启动，本会话记忆面返回 501，页面改动只留在页面内存。

旧数据转换与归档（详见 `开发文档.md` 第 43 周期）：
- 旧设置包里内嵌的 Key（`apiKey` / 各家语音 Key / `chatProviderKeys`）：启动与手机旧数据导入后
  就地转进 `elainachat_open_api_secrets`（已有值优先，转存成功才删设置包字段）；APK 原生通道
  启动时再把密钥表里 Keystore 还没有的名字回填进 Keystore
- `data/store.json` 与 `main/store.json` 同时存在：先补缺失键，再归档顶层旧文件
- `data/conversations.json`：按会话 id 合并进 `data/conversations/`，写完成标记后重命名为
  `.migrated-*`；下次启动只重试重命名，不会二次合并
- `data/memory.json`：转成六类目文件（空类目写 `[]`）后迁入 SQLite，再重命名 `.migrated-*`
- 手机 `filesDir/store.json`：只补 Go store 里缺失/为空的键，不覆盖已有值；记忆/向量/旧单卡等
  无用键不再迁入；迁移标记存在后插件状态只从 Go store 读
- `elaina_memory_vectors` 是派生兜底，成功后删除 Store 键；不进备份（见 `internal/store/backup.go`）

全文检索用的是 FTS5，但**基础驱动包里没有它**：必须 `ext/fts5` 的 `RegisterCustom` 注册分词器，
否则建虚拟表会报 `no such module: fts5`。中文分词也不能指望内置项 —— `unicode61` 把整段连续汉字
当一个 token，`trigram` 只认 ≥3 字子串；这里注册的是自带的 `elaina_bigram`（汉字两两成词、
拉丁字母与数字按词切并转小写，索引与查询同一套规则）。注册失败时索引仍能打开，搜索退化为 `LIKE`，
响应里的 `mode` 字段会写 `like`，便于一眼看出走的是哪条路径。

日志默认级别 `INFO`：每个请求一行的 `[HTTP] [DBUG]` 只在内存缓冲里，
控制台与日志文件默认不显示；需要排查时用 `LOG_CONSOLE=DEBUG` / `LOG_LEVEL=DEBUG` 打开，
或在应用内「设置 → 日志」临时调级别。可取值：`DEBUG` / `INFO` / `WARN` / `ERROR` / `CRITICAL`。

控制台配色：时间 / 模块 / 级别 / 正文分色（与 `web/js/log-viewer.js` 前端同一套色板），落盘文件始终是纯文本。
重定向到管道、文件或安卓 logcat 时自动关闭；`NO_COLOR` / `FORCE_COLOR` 与终端惯例一致，
`ELAINA_LOG_COLOR=1|0` 可强制开 / 关（优先级最高，非 TTY 也生效）。

安卓服务模式另认：`ELAINA_SERVICE_MODE=1`（只绑 127.0.0.1、0 号端口、不加载静态根与证书）、
`ELAINA_PORT_FILE`（写入真实端口）、`ELAINA_PLUGIN_STATE_FILE`（手机端旧 `filesDir/store.json`，仅作首次迁移来源；迁移后插件状态从 Go store 读）。
页面 Origin 固定为 `https://localhost`，并回 CORS。
服务模式**只认 Origin 白名单、不做会话鉴权**：页面与服务天生跨源，`SameSite=Strict` 的会话 cookie 发不出去，
要求会话会让「一设访问密码、应用立刻全部 401」；访问密码在手机上只作局域网共享的凭据（`/api/data/lan/*` 接收方要填）。
密码本身仍从 `data/config.json` 的 `password` 读回（`LoadPasswordOnly`），界面改密写的是同一个文件。

## 测试

```bash
go test ./...
```

跨语言兼容性有两处硬约束，改动时必须守住：

1. `scrypt` 的 salt 按 hex 字符串的 UTF-8 字节参与计算（与 Node `crypto.scrypt` 一致），
   否则用户已有密码会全部失效；
2. `auth.json` 的字段不能变，否则重启后旧设备要重新登录甚至进不去。
   会话凭据已是签名 token（`internal/auth/token.go`），不再读写 `sessions.json`；
   旧文件里是无实例归属的随机串，新版本无法校验，升级后需重新登录一次。
