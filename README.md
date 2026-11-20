# ElainaChat mod（Go 服务端版）

> 本目录是 **Go 服务端版本**，仓库里只有这一套服务端实现：启动脚本、Windows 打包与开发文档都以 `server/` 为准。

本地优先的 BYOK AI 角色聊天应用。程序本体只内置**文字聊天 + Agent 能力**，角色的呈现方式与界面细节交给**可装可卸的扩展包（mod）**：宿主不认识任何具体插件，插件只通过一份收窄的 host API 与固定的宿主插槽接入。

- **Go 单文件服务端**：静态编译的 Go 二进制，无运行时依赖；前端零构建，源码运行只需 Go 1.27+。
- **BYOK，数据全在本机**：接入你自己的 API Key，请求本机直连服务商，没有作者网关；支持 OpenAI 兼容 / Anthropic / OpenAI Responses 协议，可配多提供商与失败回退，每个对话还能单独绑定模型。
- **mod 优先**：立绘、Live2D、桌宠、场景背景等呈现全在扩展包里；坏插件自动隔离并写盘停用，只在插件卡片上说明原因，不牵连宿主与其它插件。桌面版插件可申请原生透明置顶窗（桌宠），纯浏览器不可用、插件自带兜底。
- **Agent 操作**：模型可读写文件、执行命令、操作手机（点击 / 滑动 / 输入 / 截图 / 读通知短信通讯录日历）、写日记记忆、创建定时任务；操作说明书按需下发，权限分档（关闭 / 逐条确认 / 自动通过 / 完全访问）。
- **手机 Agent 可靠**：「打开应用」按已装应用解析并以前台应用核对结果；无控件树画面自动叠加坐标网格；「停止」立即生效，迟到的旧回复作废。
- **手机读取类信息只认系统权限一道闸**：应用内不设开关，撤销只能去系统设置；设置页提供一键授权。
- **人设与对话**：人设卡一文件随时切换；消息支持 Markdown 与 LaTeX（公式走 KaTeX，原始 HTML 一律当字面量）。
- **记忆**：每过若干轮自动写日记，聊天时按需检索；整理与召回用的模型在设置里自选。
- **主题与移动端**：暗夜魔女书房（默认）/ 暖米绿 / 雾蓝日系 / 石墨玻璃，浅色 / 深色 / 跟随系统；窄屏是独立外壳（底栏导航、长按菜单、分类文件夹、拖拽排序）。
- **推理型网关兼容**：续跑输出预算独立放宽、思考参数自适应、空输出自动放宽重试。
- **联网搜索与浏览器**：内置 Tavily 与自定义搜索源；也可开独立浏览器窗口看页面、点按钮、填表单。
- **MCP 客户端**：填一个地址（Streamable HTTP）或启动命令（stdio）接入 MCP 服务器，工具自动进 AI 能力清单；只做客户端，不暴露本机能力。
- **语音**：云端 ASR（阿里百炼 / 小米 MiMo）与多服务商 TTS（MiMo / MiniMax 克隆音色 / Qwen-TTS / OpenAI 兼容）。
- **定时任务**：对 AI 说「每天提醒我…」即建任务，到点以角色身份主动发消息；安卓需允许自启动并锁定后台。
- **成就**：事件成就与进度成就，解锁后持久保留。
- **访问控制**：默认只监听本机；改配置可对局域网开放，设置密码后所有设备需登录，同端口支持 HTTP/HTTPS。
- **备份与局域网共享**：导出 / 导入标准 zip（`data/` + `mods/` + `skills/`）；局域网两台设备可凭对方访问密码直接互拉。
- **多实例**：每个实例配独立 `DATA_DIR` 与端口即可并行，会话凭据按实例隔离；共用同一 `DATA_DIR` 不受支持。
- **版本检测**：设置里查 GitHub 最新 Release 并给出对应安装包，只提示与下载，不自动替换程序。
- **日志**：分色显示、按级别与模块筛选、可导出；敏感字段（含 API Key）落盘前脱敏。

## 目录

- 下载与安装
- 从源码运行
- 双端能力对比
- 扩展包（Mod）
- 技能（Skills）
- 目录结构
- 技术栈
- 开发
- 隐私与数据
- 开源协议
- 致谢

## 下载与安装

到 [Releases](https://github.com/XYZ921746/ElainaChat-mod/releases/latest) 下载对应平台的包，文件名**以 Releases 页面实际列出的为准**。

### 电脑版（WebView2 外壳，推荐）

下载 `ElainaChatMod-Setup.exe` 安装，或直接解压便携版 zip；**不需要**安装 Node.js 或 Go。安装包创建开始菜单与桌面快捷方式，卸载可选保留聊天数据。

```text
ElainaChat Mod/
├─ ElainaChat Mod.exe    # WebView2 外壳：拉起服务端并打开界面，托盘常驻
├─ server/elaina-server.exe  # Go 服务端（单文件，无运行时依赖）
├─ shell.json            # 外壳配置（入口、端口）
├─ app/                  # 前端本体（web/、skills/ …）与 app\data\
└─ README.md             # 便携版使用说明
```

- 数据在 `app\data\`，随目录移动；关窗口 = 最小化到托盘，托盘右键「退出」才是真正退出。
- 系统要求：.NET Framework 4.8 与 WebView2 运行时（Win10 1903 以后一般自带）。不建议更老的系统跑桌面版，网页版与安卓版没有这些要求。

### 安卓版

下载 arm64-v8a 的 APK，允许「安装未知来源应用」后安装。APK 把 `web/` 打进 WebView，服务端是同一个 Go 单文件，在独立进程里执行；构建开关 `ELAINA_LOCAL_SERVER`（默认开）决定是否打包服务端，关闭后聊天数据只读、备份与共享不可用。

- 包名 `com.elainachat.mod`，与更早的 `com.elainachat.opensource` 包**不兼容**（无法覆盖安装）；卸载会清空数据，请先在旧版导出备份。

## 从源码运行

```bash
cd server
go build -o bin/elaina-server.exe ./cmd/elaina-server
cd ..
./server/bin/elaina-server.exe
# 浏览器打开 http://127.0.0.1:3999
```

- 需要 Go 1.27+，不需要 `npm install`。不想手动编译就双击 `启动.bat`：已有构建直接跑，二进制缺失或源码更新时先问是否构建（选「不构建」直接退出；本机没有 Go 工具链会自动下载安装）。
- 端口以 `data/config.json` 的 `port` 为准（默认 **3999**），被占用就报错退出，不会静默换端口；本项目的另一个实例已占着端口时，只把浏览器指过去然后退出。
- 想改完代码直接跑：`npm start`，或 `cd server && go run ./cmd/elaina-server`。国内网络下 `proxy.golang.org` 不可达时先 `go env -w GOPROXY=https://goproxy.cn,direct`。
- 数据目录 `data/` 首次启动自动生成；删除后重启即干净实例。

## 双端能力对比

| 能力 | 电脑版 | 安卓版（APK） |
|---|---|---|
| 文字聊天 / 语音 / 主题 / 人设 / 成就 | 支持 | 支持 |
| AI 操作电脑（读写文件 / 执行命令） | 支持（可访问任意路径，按权限档决定问不问） | 不支持 |
| AI 操作手机（点击 / 滑动 / 输入 / 截图 / 读通知短信通讯录日历） | 不支持 | 支持（读取类信息只由系统权限决定，应用内不设开关） |
| AI 读写手机文件 | 不支持 | 支持（Agent 工作区 + 你授权的一个文件夹） |
| 插件安装 / 卸载 | 支持（丢进 `mods/`、应用内市场或「上传安装」） | 支持（只能应用内市场 / 「上传安装」） |
| 插件的桌面置顶窗（`host.desktopWindow`） | 支持（只有 WebView2 桌面壳有；纯浏览器里 `available()` 为 false） | 不支持 |
| 插件的服务端半边（`manifest.server`） | 支持（Go 宿主 `server/internal/plugin` 装载） | 支持（同一个 Go 宿主在 `:node` 进程里装载；关掉 `ELAINA_LOCAL_SERVER` 时回落原生兜底） |
| AI 用浏览器 / MCP 客户端 | 支持 | 不支持（这两项依赖电脑侧的本机服务） |
| 数据备份 | 导出 v4 标准 zip：`data/`（聊天数据 + 记忆逻辑导出）+ `mods/` + `skills/` | 导出到手机存储的 v4 zip，与电脑版互相导入；插件 / 技能、记忆都保留 |

## 扩展包（Mod）

仓库**不含任何插件源码**：插件经「设置 → 扩展 › 插件 → ✦ 插件市场」安装，或「上传安装」一个 zip，电脑版也可以把 zip 丢进 `mods/`。

- **默认关闭**：只有 `manifest.json` 显式写 `"defaultEnabled": true` 的插件才默认启用——插件会改界面，不该在你不知情时生效。
- **前置依赖**：打开插件时其前置自动一起打开；前置缺失时拒绝启动并在卡片写明缺什么。有插件正在依赖时，被依赖的插件不能直接关闭或卸载。
- **失败隔离**：坏插件自动停用并写盘，下次启动不再重试；原因只显示在那张插件卡片上。
- **能力要声明**：重能力必须在 `manifest.capabilities` 逐组声明，没声明的成员根本不存在；碰磁盘或网络的服务端半边还要在 `manifest.server.capabilities` 声明。
- **高危能力**：声明 `manifest.server.capabilities: ["exec"]`（执行本机命令）的插件**必须你在「设置 → 扩展 › 插件」里手动打开开关并确认**才能跑——manifest 里的 `defaultEnabled:true` 对 exec 无效。其余服务端能力（目录内读写、路由、静态等）都局限于插件自己声明的地址与目录，无需弹窗。
- **写插件**：完整指南在 [`skills/mod-authoring-guide/`](skills/mod-authoring-guide/SKILL.md)；契约与插槽清单见 [开发文档](开发文档.md)。

## 技能（Skills）

技能是**给 AI 的指令与知识**（一个目录一份 `SKILL.md`，纯文本），与插件平行但独立：插件扩展应用本身，技能只进 AI 的资料库。

- 本地技能放 `skills/<id>/SKILL.md`，在「设置 → 扩展 → 技能」里管理；插件也可随附技能（`manifest.skills`），卸载插件时随之消失。
- 技能不占普通对话上下文：模型先看到一行索引，真要正文时再用 `agent_help` 取回。

## 目录结构

```text
ElainaChat-mod/
├─ web/                     # 前端本体（唯一前端编辑入口）与静态根
│  ├─ index.html            # 单页骨架
│  ├─ js/                   # 前端模块（store / core / data / agent / ui / voice / settings / mods / mcp / mobile-shell …）
│  ├─ css/                  # 样式层：base.css 打头，themes / redesign / layout-full / pages-luxe / mobile-shell / settings 依次覆盖，tailwind.css（构建时生成）收口
│  ├─ vendor/               # 宿主自带库（KaTeX 公式渲染与字体）
│  ├─ audio/  icons/        # 内置参考音频、应用图标（favicon 与页内头像）
├─ server/                  # 电脑版服务端（Go：路由 / 数据 / 插件宿主 / 中转 / MCP / 浏览器 / 日志）
│  ├─ cmd/elaina-server/    # 入口（配置、鉴权、证书、监听）
│  └─ internal/             # 各领域包与测试
├─ scripts/                 # 只放验证脚本：npm run check 跑的 check-*.mjs + 共用运行时
├─ skills/                  # 技能目录（给 AI 的纯文本指令与知识）
├─ mods/                    # 扩展包安装位（插件源码不入库；经应用内市场安装）
├─ data/                    # 运行时数据（主 data + 对话 data）
├─ 启动.bat                 # Windows 双击启动（缺失或源码更新时先问是否构建）
├─ 开发文档.md               # 架构、契约表与变更史
└─ package.json
```

- **`data/` 分两层**：`main/` 是软件级记录（设置、密钥、人设卡、记忆），`conversations/` 一个对话一个 JSON；`logs/`、证书与 `config.json` 是服务运行件。详见 [开发文档](开发文档.md) 第 2 节。
- **壳与适配工程入库，打包工具链与签名不入库**：安卓原生工程在 [`dist/Android/`](dist/Android/README.md)，Windows 壳源码在 [`dist/Windows/`](dist/Windows/README.md)；仓库不含一键打包脚本与签名材料，建议流程见两份 README。

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| **前端** | 原生 ES 模块 + Tailwind（构建时预生成 CSS）+ KaTeX | 无打包器、无框架，静态文件即本体（工具类由 `npm run build:tailwind` 预生成）；Markdown / LaTeX 走自写渲染器，模型输出一律转义后拼标签 |
| **服务端** | Go（静态编译单文件） | 标准库起家、无 Web 框架依赖，一个二进制即整个后端 |
| **插件服务端半边** | goja（Go 内嵌 JS 引擎） | 插件的服务端代码跑在 Go 进程内，不需要额外起 Node |
| **记忆索引** | SQLite + FTS5（ncruces/go-sqlite3） | 纯 Go、无 CGO 的 SQLite，日记与召回的全文检索底座 |
| **桌面壳** | C# + WebView2 | 托盘常驻，自动拉起服务端并打开界面 |
| **安卓壳** | Capacitor + WebView | 同一份 `web/` 打进 WebView，Go 服务端以 `.so` 在 `:node` 进程里跑 |

## 开发

- `npm run check`：运行全部检查模块，清单**以 [`scripts/run-checks.mjs`](scripts/run-checks.mjs) 为准**；可加用例名子串只跑一段。`check-go` 跑 Go 编译 / vet / 测试，依赖本机环境的用例自动跳过。
- 可数的事实（检查模块数、扩展包数、插槽数、脚本加载数）一律**以对应文件实物为准**，本文不写死数字。
- 本地打包：仓库不内置打包脚本，建议流程见 [`dist/Windows/README.md`](dist/Windows/README.md) 与 [`dist/Android/README.md`](dist/Android/README.md)；签名材料绝不入库，fork 者用自己的签名。
- 架构、契约表与变更史见 [开发文档](开发文档.md)，更新公告见 [CHANGELOG](CHANGELOG.md)。

## 隐私与数据

- 聊天记录、设置、API Key 全部存在本地 `data/`，不进仓库、不上传作者服务器；请求由本机直连你填的服务商。
- 访问密码以明文写在 `data/config.json` 的 `password`（唯一持久形态，设置里修改也写回这里）；规则为至少 8 位、数字 + 其他字符。`data/` 已被 `.gitignore` 排除。
- 自签 HTTPS 证书默认在 `data/cert.pem` 与 `data/key.pem`，可替换。
- 日志写入 `data/logs/`，敏感字段落盘前脱敏。
- 手机版数据统一在应用私有目录 `elaina-data/`；API Key 走 Android Keystore 加密。

## 开源协议

本项目基于 [ElainaChat-Open](https://github.com/KaimeranFeran/ElainaChat-Open)（MIT）二次开发，以 **GPL-3.0-or-later** 发布，全文见 [LICENSE](LICENSE)。

- 分发或二次开发本项目代码时，须同样以 GPLv3 开源并提供对应源码；
- 上游采用 MIT（宽松许可，允许再许可），整体以 GPLv3 发布合规，原作者版权声明继续保留；
- 仓库只含宿主程序本体，不含任何插件，也不含插件、Live2D 模型等非本仓库内容，相关素材按各自开源协议使用；
- 角色名称与角色卡内容（如「伊蕾娜」「灰之魔女」等）出自各自原作，权利属于原作者；图片素材、Mod、Live2D 模型的权利**不因代码开源而自动转移**；
- 第三方服务商商标（DeepSeek、Anthropic、阿里云、小米等）属于各自公司，本项目与它们没有隶属或合作关系；
- 仓库内的角色卡只是示例数据，换成你自己的角色请直接改；
- 代码部分按 GPLv3 处理，上述非代码内容在二次开发或分发时需要自行确认授权。

## 致谢

- [ElainaChat-Open](https://github.com/KaimeranFeran/ElainaChat-Open) —— 上游项目，本项目的原型
- [AstrBot](https://github.com/AstrBotDevs/AstrBot) —— 灵感来源
- [KaTeX](https://github.com/KaTeX/KaTeX) —— 数学公式渲染
- [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) —— 样式层
- [SQLite](https://www.sqlite.org/) —— 记忆索引的数据库引擎（ncruces/go-sqlite3 纯 Go 内嵌，FTS5 全文检索）
- [agent-mobile-use](https://github.com/AcidGr/agent-mobile-use) —— 后台操作模块支持
- [DeepSeek](https://www.deepseek.com/) —— 开发期代码助手
