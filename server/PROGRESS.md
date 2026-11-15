# 迁移进度

本目录（server/）是仓库唯一服务端实现，`npm start` / `启动.bat` / 安卓 jniLibsServer 都已接入。每次推进后更新本文件，
长期任务按这里的「下一个」继续，不要重复已完成项。

> 历史条目里「保留 Node 实现作对照」「不迁移检查脚本」等计划，已被 2026-11-10 的收编取代：
> Node 实现已删除，检查脚本与服务端都以 `server/` 的 Go 实现为准。

## 已完成

### 2026-11-11 · 访问密码改存 config.json

- 界面改密后新密码明文写入 `data/config.json` 的 `password` 字段并删除旧密码文件（auth.json / web/.local-auth.json）；启动时 config 密码权威派生哈希、不再重建 auth.json。
- 向下兼容：config 没写 password 时旧 auth.json 照常生效；config 管理状态下 UI 仍可改密（写 config），409 拒绝分支移除，设置页输入框不再被禁用。
- 实现：`auth.SetPasswordInMemory` / `auth.ClearSessions`（`SetPassword` 重构复用）、`config.SetConfigPassword`（保留字段 / 缺失建最小对象 / 损坏拒绝覆盖 / 原子写）、Server 注入 configPath；设置页与登录页提示同步。
- 验证：go test（config/auth/httpapi 新用例：保留字段、删文件不动会话、改密写 config + 重启模拟）；`check-security` 新增改密写 config / 删 auth.json 断言；全量以运行输出为准。
- 检查基建：并发全量假红根因修复——`run-checks` 按 worker 给子进程注入不相交的 `ELAINA_CHECK_PORT_BASE` 端口区间，`startGoServer` 默认把 `ELAINA_CONFIG_FILE` 指到各自 DATA_DIR（改密用例写共享配置会让后启动的模块带起密码）。

### 2026-11-10 · 提示词层级 + 向量表 v4 + 旧值转换

- 提示词：system 消息统一带 1-5 级标签（宿主系统 / 用户设定 / 插件提示 / 运行时能力 / 记忆资料），
  记忆规则与记忆数据拆开；核心协议的事实优先级不再用数字编号，避免与提示词层级冲突。
- 向量：`vectors` 改 `(fingerprint, id)` 复合主键 + `vector_buckets`（dims / ready / build_id）；
  新增 `begin`（无条件接管同指纹构建）与 `commit`（校验 buildId），未 commit 的桶读出为空；
  删除按指纹收窄，维度冲突 400、旧 build 409、超大请求 413。
- 前端：对话模型兜底指纹固定为 `chat-keywords|int8q1|kw2`，中文关键词改 2-gram；重建走
  begin→upsert(buildId)→commit，409 时清空本轮索引；查询维度与桶不一致时重置桶回退关键词。
  兜底提示词补输入边界、JSON 结构与 1.0/0.7/0.3/0 评分标尺。
- 旧值：`legacy_core_migrated` 真正生效（置位后残留记忆只归档不导入）；备份移动整批回滚、
  恢复合并全部备份目录；分类记忆按类目合并，空类目写 `[]`；`conversations.json` 按 id 合并 +
  完成标记；`store.json` 双份时先补缺失键再归档；手机迁移只补空键并过滤无用键；
  旧设置包内嵌 Key 在删除字段前转进密钥表；前端不再写旧单卡镜像，记忆旧键移出 DATA_KEYS。
- 内嵌 Key 转存补口：Go 启动迁移与手机导入后就地转存（`MigrateEmbeddedLegacySecrets`，
  名单与前端 `API_SECRET_NAMES` 对应），APK 原生读取分支把密钥表里 Keystore 缺的名字回填进
  Keystore —— 「只起服务不开页面」与「只装 APK」两个场景的老 Key 不再丢。
- 验证：`go test ./...` 全绿；`check-agent`、`check-stream`、`check-mod`、`check-system`、
  `check-data`、`check-chat`、`check-frontend`、`check-security` 通过；`npm run check` 全量
  通过，具体通过数见最后一次运行输出。

### 2026-11-10 · 手机数据统一到 Go store

- 服务模式启动时把旧 `filesDir/store.json` 一次性迁入 Go store（标记 `main/.mobile-store-migrated`，旧文件改名 `.migrated-*` 保留）；插件状态在文件缺失后回退 Go store。
- 手机 `store.js` 原生后端改走绝对 `__nodeBase + /api/store`（`X-Store-Client`），`store.cache.json` 只在服务未就绪时兜底读；加载用 replace 语义。
- 手机备份 / 数据面板 / 局域网共享改走 `/api/data/*`；`chat-backup.js` 删除。
- 手机 LAN 共享双向放开：service mode 允许无访问密码、仅 6 位验证码的临时共享；PC 端仍要求访问密码。

### 2026-11-10 · 密码规则放宽 + 局域网共享验证码

- 密码规则改为 ≥8 位、数字 + 其他字符（字母或符号），不再强制大小写；客户端提示、登录页与重置说明同步。
- 局域网共享改为 5 分钟有效、6 位随机验证码；`/api/auth/login` 同时接受验证码与访问密码（旧接收端兼容），连错 5 次自动换码。
- `host=127.0.0.1` 时共享临时监听 `0.0.0.0` 的随机端口，只暴露登录与导出；主应用仍只绑回环。

### 2026-11-09 · 基础服务端 + 数据层

- 同端口 HTTP/HTTPS 复用（首字节 `0x16` 分流）、自签证书（`crypto/x509`，不依赖 openssl）
- 静态资源（`web/`、`mods/`）、路径穿越与隐藏文件拦截、Host 白名单、跨站请求拦截
- `data/config.json`：端口 / host / HTTPS / 自定义证书路径（环境变量优先）
- 访问密码 / 会话 / 改密 / 防爆破 / 密码强度；`data/auth.json`、`data/sessions.json` 格式兼容
- `/api/server-info`、`/api/ping`、`/api/auth/*`、`/api/client-log`
- 端口扫描与「已有实例」识别（退出码 3）
- `/api/store` GET/POST、`/api/store/stream`（SSE，25 秒心跳、跳过发起方）
- 磁盘布局与 `server/store.mjs` 对齐：`data/main/store.json`、`characters/`、`conversations/`、
  `memory/`、`voice-samples/`，含旧单文件 `store.json` / `conversations.json` / `memory.json`
  与 `data/` 顶层目录收进 `main/` 的一次性迁移；参考音频拆分 / 拼回
- `go test ./...` 覆盖：scrypt RFC 向量、密码强度、防爆破、网络边界、store 读写/迁移/语音样本、HTTP store 往返

体积：`go build -trimpath -ldflags "-s -w"` 产出约 9.9MB 单文件（M1 时点；M2 加入 goja 后约 18MB）。

### 2026-11-09 · M2 插件宿主与收窄 ctx 契约（方案二）

- 新增 `internal/plugin`：扫描 `mods/`、生成 `/mods/index.json`（字段与 `server/mods.mjs` 一致）、
  装载 `manifest.server.entry`、分发插件路由、解析插件静态目录、上传目录按二进制流返回
- 入口只允许 `export function register(ctx)`，`import` / `require` 直接拒绝（goja 无 ESM）
- `ctx.fs` / `ctx.path` / `ctx.zip` / `ctx.exec` / `ctx.base64` / `ctx.utils`；
  `fs-read` / `fs-write` / `exec` / `zip` 四个新能力名，调用点全部先过 `need(capability)`
- `ctx.fs` 路径限制在插件目录内；解压走宿主唯一实现（体积上限 / 危险扩展名 / GBK / 路径穿越）
- 请求体由宿主预读为 `request.body`，不再把流暴露给插件；handler 返回 `false` 可继续下一个路由
- Node 宿主 `server/mod-server.mjs` 同步同一套 ctx 与能力名；`ctx.readJson` 改为读 `request.body`
- 重写 `mods/pet-1.1.0/server.mjs`（`ctx.exec` + `ctx.base64`）与
  `mods/live2d-models-1.0.0/server.mjs`（`ctx.fs` / `ctx.path` / `ctx.zip`）；
  manifest 能力分别为 `route-register,exec` 与 `route-register,static-read,fs-read,fs-write,zip`
- 验证：`node scripts/check-mod.mjs` 399 通过 / 0 失败；`go test ./...` 全绿；
  真实服务里 `/api/live2d/models`、`/live2d/vendor/*`、zip 上传 / 重命名 / 删除均通过
- 文档：`开发文档.md` 表 A23 与第 24 周期变更史已同步

**注意**：`mods/` 不入库（见 `.gitignore` 与 `.aiinclude`），这两个内置插件的改动要同步到插件仓库
（XYZ921746/web），否则发行版里仍是旧写法。

### 2026-11-09 · M3（部分）relay 中转

- 新增 `internal/relay`：`POST /api/relay`，把 AI 请求搬到服务端发出，绕开浏览器 CORS
- SSRF 防护：协议白名单、云元数据地址拒绝；本机与局域网来源可访问内网服务商，公网来源不许打回环/内网；
  拨号器按解析出的 IP 再判一次并直接拨 IP（防 DNS rebinding 的 TOCTOU），不走系统代理
- 转发语义：剥离 Host/Cookie/Origin/Referer 等浏览器身份头、`accept-encoding: identity`、
  手动跳转（3xx 原样返回）、GET/HEAD/POST/PUT/PATCH/DELETE、32MB 请求体上限
- 超时：默认 120s、最短 1s、硬顶 10 分钟；等响应头与正文空闲都计时，收到数据就续期
- 流式：SSE 逐块 flush、`X-Accel-Buffering: no`；TLS 握手类失败自动用 TLS 1.2 重试一次
- 追踪：请求/响应摘要进日志（`[Chat] 提问 / 回复`），图片只记大小不记 base64；
  流式响应里 `data:` 行的报错也能挖出来
- 验证：`go test ./internal/relay` 覆盖转发、头过滤、SSRF、方法/协议校验、上游错误透传、
  SSE、等头超时、摘要/报错解析；真实服务 + 本地 echo 上游冒烟通过

### 2026-11-09 · M3（部分）日志缓冲与查看器接口

- `logx` 增加 3000 条环形缓冲：每条日志都进缓冲，不受落盘级别约束；
  `/api/logs/tail` 读取时按级别 / 模块 / 关键词过滤，新→旧返回
- 增量游标支持 `since`（时间戳）与 `sinceSeq`（同毫秒内的写入序号），
  只给 `since` 时保持严格 `>` 语义
- `/api/logs/settings` GET/POST：落盘级别、控制台级别、对话追踪开关可在运行期调整；
  日志全文改用 `Tracef`，关掉追踪只影响全文，提问/回复摘要仍保留
- 验证：`go test ./...`（缓冲过滤 / 游标 / 级别控制 / HTTP 路由）全绿；
  真实服务冒烟：`/api/logs/tail` 返回启动日志与模块标签，改级别后新 DEBUG 不再落盘

### 2026-11-09 · M3（部分）agent 文件接口

- 新增 `internal/agent`：`/api/agent/roots|ls|read|write|delete`，以及 `internal/pccmd` 的 `/api/agent/exec`
- 档位与 Node 版一致：off 整块关闭；strict 每次写 / 删都要 `overwrite` / `confirmed`；
  auto 允许写但禁止删除；full 全放行。档位以 store 里的 `agentAccess` 为准，
  请求参数只在设置缺失时兜底（不让前端自己宣布自己是 full）
- 路径支持 `%DESKTOP%` / `%DOCUMENTS%` 等别名与 `~`；根目录探测含 OneDrive 变体
- 应用目录内非 full 档禁止写 `.html/.js/.svg/.exe` 等可执行类型；删除守卫覆盖盘符根、
  项目根、应用目录、系统目录与 Program Files
- `read` 上限 300KB、`write` 上限 1MB；错误文案带真实位置提示，AI 下一轮能自己纠正
- `/api/agent/exec`：危险命令规则表（删除 / 关机 / 注册表 / 下载执行 / 管道直灌 shell / 重定向系统路径等），
  strict 每条都要 `approved`、auto 只拦危险命令、full 全放行；30s 超时、2 万字符输出截断、
  PowerShell 强制 UTF-8、命令作为单个 argv 交给 shell
- 验证：`go test ./...`（列表排序 / 读写 / 确认分支 / auto 禁删 / 应用目录守卫 / 档位来源 /
  别名展开 / 危险命令分类 / 超时与截断）全绿；真实服务冒烟：roots / ls / read / strict 写确认 /
  auto 禁删 / 确认删除 / exec full 执行 / strict 未确认拒绝 / auto 危险命令拒绝

### 2026-11-09 · M3 完成：备份 / 插件 / 技能 / MCP / 浏览器 / 活动 / 局域网 / 版本检测

- `internal/zipx`：全库唯一 zip 读写与解压安全规则；`internal/plugin/zip.go` 改为薄包装
- 备份：`/api/data/export|import|info`，v1/v2/v3 布局与 merge/replace 语义对齐 `server/store.mjs`
- `internal/packages`：插件 / 技能扫描、安装、卸载、README / SKILL.md、备份收集与恢复
  （`/api/plugins`、`/api/skills` 全部接口）
- `internal/mcp`：stdio + Streamable HTTP 客户端与注册表；`/api/mcp/*` 五个接口
- `internal/browser` + `internal/wsx`：CDP 浏览器（临时 profile、只绑回环、URL 白名单、空闲关闭）
- `internal/activity`：前台窗口 / 进程（PowerShell，UTF-8 / GBK 双解码，带缓存）
- `internal/lanshare`：`enable` / `export` / `pull`，30 分钟开关与私网 SSRF 校验
- `internal/updatecheck`：GitHub Release 检测（缓存、错误归一化、公共 DNS 直连、hosts 证据）

### 2026-11-09 · M4：运行时与打包切到 Go

- `启动.bat` 运行 `server-go/bin/elaina-server.exe`（缺失时用本机 Go 编译，不再回落 Node）
- `dist/Windows/shell/ShellHost.cs` 启动 `server\elaina-server.exe`；`Form1.cs` 改用
  `ServerExited` / `ServerExitCode`；日志 `app/logs/server.log`
- `dist/Windows/build-installer.cmd` 编译 Go 二进制，包内不再带 `node/`
- `scripts/check-go.mjs`（build / vet / test，无 Go 时环境性跳过）已登记进 `run-checks.mjs`
- README、`开发文档.md` 第 2/4/8/11 节同步；`go test ./...` 与 `npm run check` 全绿

### 2026-11-09 · M4 续：安卓 APK 服务端迁到 Go（用户授权 D10 例外）

- 服务模式：`ELAINA_SERVICE_MODE=1`、`ELAINA_PORT_FILE`、`ELAINA_PLUGIN_STATE_FILE`；
  Origin 固定 `https://localhost` + CORS；`/api/ping` / `/api/mods/status` / `/api/shutdown`
- `ElainaNodeService.java`：ProcessBuilder 执行 `nativeLibraryDir/libelaina_server.so`，
  端口文件轮询 → Messenger，stdout 转 logcat，停止走 `/api/shutdown`
- `build.gradle`：`ELAINA_LOCAL_SERVER` 开关、`jniLibsServer` 独立目录、`useLegacyPackaging=true`、
  versionCode 12；`sync-web.mjs` 交叉编译 arm64-v8a / x86_64
- 验证：Android 15 x86_64 模拟器跑通 debug APK 的 exec / 端口 / 插件路由 / logs / shutdown

## 下一个

- 内置插件源码在插件仓库（XYZ921746/web），`mods/` 不入库；修改 `mods/*/server.mjs` 时要同步过去。

## 待确认

- `elaina_open_character_card`（旧格式的「当前生效角色卡」）在 Node 版里也不落盘，
  重启后消失；Go 版保持同行为，若前端仍需它需要单独立项。
- 安卓 arm64 发布包未在 arm64 环境实测：本机是 x86_64 Windows，Android Emulator 37.2
  明确拒绝 arm64 系统镜像（`Avd's CPU Architecture 'arm64' is not supported by the QEMU2
  emulator on x86_64 host`）；直接拉起自带 QEMU 2.12 的 aarch64 设备又卡在 ranchu 无 PCI
  总线（`PCI bus not available for virtio-snd-pci` / `hda`），未能在本机得到可用 arm64 环境。
  已用 release 双 ABI 测试包（`-PelainaReleaseAbis=arm64-v8a,x86_64`）在 x86_64 模拟器验证
  R8 之后的 exec / ping / 插件路由 / logs / shutdown；arm64 二进制本身只做了 ABI/ELF 与打包校验。
- 若日后有 arm64 真机或 arm64 host：装 release APK，确认 `:node` 执行 `libelaina_server.so`、
  `/api/ping` 的 `runtime=go`、插件路由可调即可补上这一格。

## 约束（每次运行都要遵守）

- 不修改 `android-app/`，除非用户明确授权
- 不用 `git checkout` / `restore` / `reset --hard` / `stash drop`（D17）
- 不新增 npm 依赖；不执行 `git commit`（用户未要求）
- 新增注释只写「为什么」（D8）
