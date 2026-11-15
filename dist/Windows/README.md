# dist/Windows —— Windows 桌面壳（WebView2）

壳源码随仓库走：`shell/` 是 C# WinForms + WebView2 外壳，负责拉起 Go 服务端并打开界面。
**打包工具链不入仓库**——怎么打包、用什么工具，由 fork 者自行决定；本文只提供本项目作者
使用过的做法作为建议。

## 这个目录里有什么

```
dist/Windows/
├─ shell/      # WebView2 外壳源码（C# WinForms）与 build.cmd 编译脚本 —— 入库
├─ README.md   # 本文件 —— 入库
├─ out\        # 本机打包产物（不入库）
└─ tools\      # 本机工具链（不入库；GitHub 上克隆不到）
```

## 运行前提（最终用户）

桌面版外壳需要 **.NET Framework 4.8** 与 **WebView2 运行时**的支持，Windows 10 1903 以后的版本一般自带（缺失时外壳提示初始化失败）。

**不建议 Windows 10 1903 以前的系统运行桌面打包版本**。网页版与安卓版没有这些要求。

## 打包建议（给 fork 者）

以下步骤是本项目作者验证过的做法，**仅供参考，不是唯一路径**：

1. **编译壳**：`shell\build.cmd [icon.ico]`。代码用 C# 11 语法，需要 Roslyn 编译器
   （VS BuildTools 或 dotnet SDK 自带，脚本会自动探测）；WebView2 NuGet 包
   `microsoft.web.webview2` **1.0.4314.35** 需在 nuget 缓存
   （`%USERPROFILE%\.nuget\packages\`）中，壳编译时引用并内嵌 Loader。
   可选传入 `.ico` 作为 exe 图标（`web\icons\icon-512.png` 可转多尺寸 ico）。
2. **编译服务端**：在 `server\` 下 `go build -trimpath -ldflags "-s -w" -o <输出> .\cmd\elaina-server`
   （Go 1.27+）。**发布要求：二进制必须经 UPX 压缩**（`upx --best`，26.7M → 约 9.3M，
   `upx -t` 校验通过再打包）；UPX 未装时 `winget install UPX.UPX`（官方 GitHub release zip 兜底）。
3. **组装便携目录**：`ElainaChat.exe`（壳）+ `server\elaina-server.exe`（服务端）+
   `app\`（仓库的 `web\`、`skills\` 等静态资源；运行期数据在 `app\data\`，随包生成）+
   `shell.json`（外壳配置：入口 `server\elaina-server.exe`、端口 4123、探活
   `/api/server-info`，格式见根 README 的包内结构说明）。
4. **安装器**：可用 NSIS、Inno Setup 等自行制作（本项目曾用 NSIS 3.13 脚本 +
   `package.json` 的版本号注入，现未随仓库分发）。
5. **冒烟**：起壳后探测 `http://127.0.0.1:4123/api/server-info` 应返回
   `"edition":"windows"`。

## 签名与许可

- 分发前可用你自己的代码签名证书对 exe / 安装包签名（可选，仓库不包含任何证书）。
- **打包分发须遵循 GPL-3.0-or-later**：保留根目录 `LICENSE`，以同许可开放对应源码；
  根 README 的许可章节（含上游 MIT 组件的声明）继续适用。

## 壳的行为要点

- 启动：以固定端口（shell.json 的 port，默认 4123）拉起 `server\elaina-server.exe`，
  探测 `/api/server-info` 就绪后打开窗口；失败弹窗并附日志尾部
- 进程：服务端二进制挂在 kill-on-close 作业对象上，壳被结束（含强杀/崩溃）时内核保证连带退出
- 托盘：关闭窗口 = 最小化到托盘；托盘右键「退出」才是真退出
- 单实例：同目录重复启动会唤出已有窗口
- 数据：应用数据在 `app\data\`（便携式）；WebView2 缓存在 `%LOCALAPPDATA%\ElainaChat`
- 运行形态：给服务端传 `ELAINA_EDITION=windows`，服务端经 `/api/server-info` 转给
  「设置 → 高级 → 版本与更新」，据此把 WebView2 安装包标为当前平台
