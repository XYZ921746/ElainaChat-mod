# dist/ —— 平台壳与适配工程

按目标平台分目录：`dist/Android/` 是**入库**的安卓原生工程（工具链、`www/`、构建缓存、签名文件由 `.gitignore` 排除），`dist/Windows/` 是 Windows 桌面壳源码（壳的 C# 源码随仓库走；工具链与产物留在本机）。

**两个目录都不提供一键打包脚本**——怎么打包、用什么工具，由 fork 者自行决定；各目录的 `README.md` 只提供本项目作者验证过的做法作为**建议**。签名材料（keystore / 证书）一律不入库，fork 者用自己的签名。

```text
dist/
├─ Android/                      # 安卓原生工程（**入库**，见 Android/README.md）
│  ├─ android/                   # Gradle 工程：app/（Java + res + Manifest）、gradle wrapper
│  ├─ scripts/sync-web.mjs       # 同步 ../../web → www/，并交叉编译 Go 服务端到 jniLibsServer/
│  ├─ capacitor.config.json      # Capacitor 配置
│  ├─ package.json               # Capacitor CLI 与插件依赖
│  └─ gradle-mirrors.init.gradle # Gradle 仓库镜像建议（--init-script 显式指定，可选）
└─ Windows/
   ├─ shell/                     # WebView2 外壳源码（C# WinForms）与 build.cmd —— 入库
   ├─ README.md                  # 打包建议（依赖、组装、签名、许可）—— 入库
   ├─ tools\                     # 本机工具链（不入库）
   └─ out\                       # 本机打包产物（不入库）
```

## 注意：检查脚本会读这里

`dist/Android/scripts/sync-web.mjs` 是检查夹具（`check-go` 断言它交叉编译 Go 服务端到 `jniLibsServer/`，`check-ui` 断言它同步 `web/css/`），`dist/Android` 的 Java 源码被 `check-agent` / `check-go` 直接读取，`dist/Windows/shell/ShellHost.cs` 被 `check-update` 读取。
Windows 桌面版的外壳只有本目录 `shell/` 一份源码（WebView2 外壳 + `server/elaina-server.exe`）。
