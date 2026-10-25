# ElainaChat mod

本地优先的 BYOK AI 角色聊天应用：程序本体是**文字聊天 + Agent 能力**，角色呈现与界面由**可装可卸的扩展包（mod）**决定。自带本地服务端，零依赖、免构建，数据与 API Key 全部留在本机。

- **BYOK**：接入你自己的大模型 API Key；密钥只存本机，不经第三方中转。
- **mod 优先**：宿主不认识任何具体插件，插件只通过收窄的 host API 与插槽接入；可在「设置 → 插件」随时启用/停用，装坏的插件会被自动隔离并停用，不影响宿主与其它插件。
- **四套主题**：暗夜魔女书房（默认）/ 现代极简 / 雾蓝日系 / 石墨玻璃；另有浅色 / 深色 / 跟随设备三档显示模式。
- **Agent 操作**：模型可执行对话管理、记忆检索（如 `recall_search` 凭日记找回历史原话）等操作，操作说明书按需下发。
- **插件市场**：应用内浏览与安装扩展包（Live2D、桌宠、场景背景、galgame 等）。全新克隆不带任何插件，与发布版口径一致。
- **PWA**：浏览器打开后点顶栏「安装」，即可装成桌面独立应用。
- **局域网访问**：手机/平板可用局域网地址访问，带访问密码（启动窗口打印）。

## 下载成品

到 [Releases](https://github.com/XYZ921746/ElainaChat-mod/releases/latest) 下载：

- `ElainaChat-mod-x.y.z-x64-setup.exe` —— Windows 安装包（NSIS）。
- `ElainaChat-mod-x.y.z-arm64.apk` —— Android（arm64；内嵌 Node 运行时，插件的服务端半边随包可用）。

## 从源码运行

```bash
node start.mjs
# 浏览器打开 http://127.0.0.1:3999
```

- 需要 Node.js ≥ 20；**不需要** `npm install`。
- 默认端口 **3999**，被占用时自动往上找（4000、4001…）。
- Windows 也可以直接双击 `启动.bat`（自动打开浏览器）。
- 数据目录 `data/` 首次启动自动生成；想用干净实例，删除 `data/` 后重启即可。

## 装成桌面应用（PWA）

用 `http://127.0.0.1:3999` 打开（局域网 IP 打开时浏览器不给安装入口，这是安全上下文规则），顶栏右上角会出现「安装」按钮。装好后从开始菜单启动，与浏览器版读写同一份 `data/`（服务得在跑，PWA 不是独立后端）。卸载只删快捷方式，不动数据。

## 目录

```
├─ web/        前端（web/serve.mjs 是本地服务端与静态根；web/nodejs/ 是安卓端内嵌 Node 的入口）
├─ server/     本地服务端（零依赖 .mjs 模块）
├─ mods/       插件安装位（不入库；经应用内市场安装）
├─ skills/     mod 作者指南（纯文本技能文档）
├─ scripts/    检查工具链（npm run check；模块清单以 scripts/run-checks.mjs 内的清单为准）
├─ data/       运行期数据（聊天记录 / 设置 / API Key；不入库）
├─ start.mjs   启动入口（端口策略在 web/serve.mjs）
└─ 启动.bat     Windows 双击启动
```

## 插件（mod）

插件源码不入库：仓库只推宿主本体，插件通过「设置 → 插件 → 插件市场」安装。写 mod 的完整指南在 `skills/mod-authoring-guide/`（快速开始、契约速查、持久化与服务端、零错误清单）；跨边界契约与模块职责见 `开发文档.md`。

## 开发

- `npm run check`：运行全部检查模块（清单以 `scripts/run-checks.mjs` 为准；个别依赖本机环境的用例会自动跳过）。
- 打包工具（Windows 单文件 exe / NSIS 安装包 / Android APK）不入库，工具链与构建开关说明见 `开发文档.md`。

## 隐私与数据

- 聊天记录、设置、API Key 全部存在本地 `data/`，不进仓库、不上传任何服务器。
- 局域网访问密码在 `data/auth.json`（`data/` 整目录不入库）。
- 日志写入 `data/logs/`，敏感字段（含 API Key）落盘前脱敏。

## License

[GPL-3.0-or-later](LICENSE)
