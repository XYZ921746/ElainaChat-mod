# dist/ —— 本地产物与打包工具

整目录默认不进仓库（`.gitignore` 已排除 `dist/Windows/` 与 `dist/*.exe`；`dist/Android/scripts/sync-web.mjs` 作为检查夹具单独保留）。这里按目标平台分目录，每个目录里既有「跑打包要用的工具」，也有「打包出来的东西」。

```text
dist/
├─ Android/                      # 打 APK 用
│  ├─ scripts/sync-web.mjs       # 把项目 web/ 同步进 ../android-app 的 www/
│  └─ config/README.md           # 预留：Android 侧配置说明
└─ Windows/                      # 打 Windows 桌面版用
   ├─ build-installer.cmd        # 一键打包：生成图标 → 编译外壳 → 组装便携包 → 出 NSIS 安装器
   ├─ make-ico.ps1               # 由 web/icons/icon-512.png 生成多尺寸 app.ico
   ├─ shell/                     # WebView2 外壳源码（C#）与 build.cmd
   ├─ installer/ElainaChat.nsi   # NSIS 安装器脚本
   ├─ tools/nsis-3.13/           # 内置 NSIS 便携版
   ├─ README.md                  # Windows 打包说明
   ├─ README-package.md          # 便携版随包说明
   └─ out/                       # 打包产物（构建时生成，不入库）
```

## 常用命令（在 `dist/Windows/` 下）

```cmd
build-installer.cmd
```

产物在 `dist/Windows/out/`：安装器 `ElainaChat-Setup.exe`、便携 zip 与便携目录。
依赖：本机装有 Node.js（打包脚本会复制其 node.exe 进包）；NSIS 已内置在 `tools\nsis-3.13\`；编译外壳需要 .NET Framework 4.8 + Roslyn（见 `shell/build.cmd`）。

## 注意：检查脚本会读这里

`scripts/check-log.mjs` 从 `dist/Android/scripts/sync-web.mjs` 提取 `SHARED_SERVER_MODULES`（单一事实源，检查脚本不自带一份）。`scripts/check-exe.mjs` 针对的是「单文件 exe（SEA）」方案，其 `dist/Windows/launcher/launcher.cjs` 与 `dist/Windows/scripts/pack-exe.mjs` 缺失时按环境性跳过（记为通过）；当前 Windows 打包走 `build-installer.cmd` 的「外壳 + 内置 node」方案。
