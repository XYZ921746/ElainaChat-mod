# dist/Android —— 安卓原生工程（Capacitor + Gradle）

安卓客户端本体：包名 `com.elainachat.mod`，应用名 `ElainaChat Mod`。
Web UI 通过 `ByokHttpPlugin` 直连用户选择的 HTTPS 服务，通过 `ByokSecretsPlugin` 使用
Android Keystore 加密 API Key；服务端是**同一个 Go 单文件**，由 `ElainaNodeService`
在 `:node` 独立进程里从 `nativeLibraryDir` 直接 exec。

本目录的**工程源码随仓库走**；SDK / NDK / `node_modules/` / `www/` / 构建缓存 /
签名文件由 `.gitignore` 排除——GitHub 上只有工程文件，怎么打包由 fork 者自行决定，
本文只提供建议。

## 目录

```text
dist/Android/
├─ android/                      # Gradle 工程（应用本体）—— 入库
│  ├─ build.gradle settings.gradle gradle.properties variables.gradle
│  ├─ gradle/wrapper/ gradlew gradlew.bat
│  └─ app/
│     ├─ build.gradle            # ELAINA_LOCAL_SERVER 开关、ABI 过滤、R8、签名（见下）
│     └─ src/main/               # AndroidManifest + Java + res
├─ scripts/sync-web.mjs          # 把 ../../web 同步进 www/，并交叉编译 Go 服务端到 jniLibsServer/ —— 入库
├─ package.json / package-lock.json  # Capacitor CLI 与插件依赖（sync / build:debug / build:release）—— 入库
├─ capacitor.config.json         # Capacitor 配置（webDir=www、androidScheme=https）—— 入库
├─ gradle-mirrors.init.gradle    # Gradle 仓库镜像建议（--init-script 显式指定，可选）—— 入库
├─ android-sdk\                  # （本机可选）SDK/NDK 放置处 —— 不入库
└─ node_modules/ www/ android/app/build/ 等构建产物 —— 不入库
```

## Java 文件

| 文件 | 职责 |
| --- | --- |
| `MainActivity.java` | 注册全部 Capacitor 插件；系统返回键先交给页面的 `window.ElainaHost.systemBack` |
| `ElainaNodePlugin.java` / `ElainaNodeService.java` | 本地服务客户端与 `:node` 进程宿主（Messenger 控制面 + `127.0.0.1` 数据面） |
| `ElainaShellPlugin.java` | 手机操作设备层（前端当作 `window.ElainaDevice`）；四种运行方式的路由与授权入口 |
| `ElainaAccessibilityService.java` | 前台后端：读界面、点击、滑动、输入、截图（按 displayId 也可读副屏） |
| `DisplayHolder.java` / `IDisplayHolder.aidl` | 后台副屏引擎（Shizuku 与 Root 共用）：建屏、定向启动与注入、ImageReader 抓帧 |
| `ShizukuBridge.java` / `ShizukuHolderService.java` | Shizuku / Sui 的授权与 UserService holder（shell 或 root uid） |
| `RootBridge.java` / `RootHolderMain.java` | Root 后端：`su` 起 holder，命令 / 结果 JSON 文件桥 + 一次性 token（不经 Binder / Provider） |
| `ElainaAgentService.java` | 后台会话保活（主进程 `specialUse` 前台服务 + PARTIAL_WAKE_LOCK） |
| `ElainaOverlay.java` | 系统级悬浮窗（授权确认不能落在被操作的应用里） |
| `ElainaNotificationListener.java` / `DeviceInfoReader.java` | 通知、短信、通讯录、日历、应用列表读取 |
| `AgentWorkspace.java` | Agent 工作区与用户授权文件夹 |
| `ShellBackends.java` / `ShellProcess.java` / `PhoneCommand.java` / `DeviceArtifacts.java` | 后端注册（含 holder 的「不执行任意命令」约束）、进程执行、标签翻译、dump/screencap 产物处理 |
| `ByokHttpPlugin.java` / `ByokSecretsPlugin.java` | BYOK 直连与 Keystore 密钥 |
| `EdgeTtsPlugin.java` / `MiniWebSocket.java` | Edge TTS（端点校验 UA，WebView 的 WebSocket 不能自定义请求头） |
| `ElainaExportPlugin.java` | 日志导出（SAF 让用户自选保存位置） |

## 构建建议（给 fork 者）

依赖（建议版本）：Node.js LTS（**仅构建期**，APK 运行时不含 Node）、JDK 21、
Android SDK（`compileSdk 35` / `minSdk 29`）、NDK（x86_64 调试包的交叉编译必须走
cgo；arm64 无 NDK 自动退回纯 Go）、Go 1.27+。SDK 放任意位置写入
`android\local.properties` 的 `sdk.dir=`，或直接放进 `android-sdk\`
（`sync-web.mjs` 探测这里的 `ndk\`）。

流程建议（**仅供参考，不是唯一路径**）：

```powershell
# 1) 同步前端 + 交叉编译 Go 服务端（在仓库根执行）
node dist/Android/scripts/sync-web.mjs

# 2) 还原 Capacitor 依赖并打包（cap sync + gradle）
cd dist/Android
npm install
npm run build:debug      # 或 npm run build:release
```

产物：`android\app\build\outputs\apk\debug\app-debug.apk`（release 在 `...\release\`）。

**发布要求：APK 后端必须经 UPX 压缩**。`sync-web.mjs` 每次都会重新生成**未压缩**的
`.so`，因此在 `sync-web` 之后、gradle 打包之前，对
`android\app\src\main\jniLibsServer\arm64-v8a\libelaina_server.so` 与
`...\x86_64\libelaina_server.so` 执行：

```powershell
upx --lzma <.so 路径>      # 只能 --lzma：--best 与默认档在 Android PIE 上产出坏包
upx -t  <.so 路径>         # 校验必须 [OK]
```

然后 `npm run build:release`。UPX 未装时 `winget install UPX.UPX`。压缩后需真机启动
验证服务端可运行（约 26.7M → 6.7M）。

- `sync-web.mjs` 支持 `--lite`（不带模型与 mod 图片）、`--no-models`、`--with-mods`；
  `ELAINA_LOCAL_SERVER=false` 时不交叉编译、`build.gradle` 也不收 `jniLibsServer/`，
  页面回落到原生兜底实现。
- 两个容易踩的坑：① `sync-web.mjs` 找 NDK 只认 `ANDROID_NDK_HOME` /
  `ANDROID_HOME\ndk`，不读 `local.properties`；② 克隆后 `android\local.properties`、
  `android\capacitor.settings.gradle`、`android\app\capacitor.build.gradle` 都不存在——
  前者自己建，后两者由 `cap sync` 生成，不是丢了。

## 签名（重要）

**仓库不含任何签名文件。** `release` 构建需要在 `android\` 下自建
`keystore.properties` 与你自己的 `.jks`（字段：`storeFile / storePassword /
keyAlias / keyPassword`），它们都被 `.gitignore` 排除——**不要提交任何真实签名材料**。
没配 keystore 时 `app\build.gradle` 会自动退回 debug 签名并打印警告（仅限本地验证，
**不可分发**）。正式分发请使用你自己的签名。

## 许可

**打包分发须遵循 GPL-3.0-or-later**：保留根目录 `LICENSE`，以同许可开放对应源码；
根 README 的许可章节（含上游 MIT 组件的声明）继续适用。

## 使用方式

1. 打开 APK 的设置页。
2. 选择 API 格式（OpenAI 兼容、Anthropic、Gemini 或 Ollama）并填写自己的 Key；
   如需语音，可切换 MiniMax、豆包或阿里千问 Qwen-TTS 并填写对应凭据与音色。
3. 默认使用所选格式的官方地址，也可以填写用户自己的自定义 Base URL。
4. 如需 Android 语音输入，可选择阿里百炼并填写自己的 DashScope Key。
