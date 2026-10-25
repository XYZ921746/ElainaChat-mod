# ElainaChat mod

本地优先的 BYOK AI 角色聊天应用：程序本体是**文字聊天 + Agent 能力**，角色呈现与界面由**可装可卸的扩展包（mod）**决定。零依赖、免构建，数据与 API Key 全部留在本机。

## 下载成品

到 [Releases](https://github.com/XYZ921746/ElainaChat-mod/releases/latest) 下载：

- **Windows**：`ElainaChat-mod-x.y.z-x64-setup.exe`（NSIS 安装包）
- **Android**：`ElainaChat-mod-x.y.z-arm64.apk`（arm64，内嵌 Node 运行时）

## 从源码运行

```bash
cd app
node start.mjs
# 浏览器打开 http://127.0.0.1:3999
```

需要 Node.js ≥ 20，不需要 `npm install`。启动、PWA 安装、插件与目录说明见 [app/README.md](app/README.md)。

## 仓库结构

- **`app/`** —— 工程本体：前端（`web/`）、本地服务端（`server/`）、检查工具链（`scripts/`）、mod 作者指南（`skills/`）。
- **根目录其余内容** —— 纯静态高保真设计原型（演示数据、无构建、零依赖），`node preview.mjs` 本地预览，也可以直接双击 `index.html`。
- **`开发文档.md`** —— 目录结构、模块职责、跨边界契约（manifest 字段 / host API / 插槽 spec / 服务端声明）与完整变更史。

## 隐私

聊天记录、设置、API Key 只存本机 `app/data/`，不进仓库、不上传任何服务器。局域网访问带密码，密码与本机密钥材料同样不入库。

## License

[GPL-3.0-or-later](LICENSE)
