# ElainaChat 前端重构原型

独立于 `ElainaChat-mod` 的前端重构目录。这里有两个版本，原项目始终只读：

- **根目录**：纯静态高保真原型，使用演示数据，用来对比四套视觉与交互。
- **`app/`**：可运行替换版。后端、真实前端逻辑、插件、技能和一份数据快照都已复制到 `app/`，新界面已接上真实后端；布局已按本目录原型的方案改为全屏。默认端口 **4100**，不会影响原项目 3999。

### 启动可运行版本

```bash
cd app
node start.mjs
# 浏览器打开 http://127.0.0.1:4100
```

Windows 也可以双击 `app/启动.bat`。详细说明见 [app/README.md](app/README.md)。

### 预览纯静态原型

```bash
# 在 ElainaChat-redesign 目录下
node preview.mjs
# 浏览器打开 http://127.0.0.1:4173
```

也可以直接双击 `index.html`（无构建、无依赖，`file://` 下也能运行）。

## 这一版包含什么

- **完整应用外壳**：左侧窄导航 + 对话列表 + 主区，移动端切换为抽屉 + 底部导航。
- **全部主要页面**：对话、语笺、旅行日记、成就、插件市场、设置（外观 / 角色 / 模型 / 能力 / 高级 / 插件 / 日志）。
- **四套视觉方向**，右下角「设计实验室」可一键切换，深浅色分别调校：
  1. 暗夜魔女书房 —— 羊皮纸、金线、夜航星点，衬线标题。
  2. 现代极简 —— 中性灰白、细边框、大留白，接近 Claude / ChatGPT 的阅读感。
  3. 雾蓝日系 —— 雾面玻璃、柔蓝与浅粉、圆角，轻小说氛围。
  4. 石墨玻璃 —— 深灰底、玻璃层次、单一冷光强调色。
- **可交互**：发消息（带演示回复）、停止生成、收藏/复制、搜索对话与语笺、插件安装/启停、分类管理、日记与语笺详情、语音通话浮层、公告、快捷键 `Esc` / `Ctrl+K`。
- **响应式**：桌面、平板、手机三档；`prefers-reduced-motion` 下关闭动效。

## 预览截图

| 暗夜魔女书房 | 现代极简 |
| --- | --- |
| ![](screenshots/desktop-majo-chat.png) | ![](screenshots/desktop-minimal-chat.png) |
| 雾蓝日系 · 语笺 | 石墨玻璃 · 插件市场 |
| ![](screenshots/desktop-mist-notes.png) | ![](screenshots/desktop-glass-market.png) |
| 设置 · 暗夜魔女书房 | 成就 · 暗夜魔女书房 |
| ![](screenshots/desktop-majo-settings.png) | ![](screenshots/desktop-majo-achievements.png) |
| 设计实验室 | 手机端对话 |
| ![](screenshots/desktop-design-lab.png) | ![](screenshots/mobile-majo-chat.png) |
| 玻璃主题弹窗 | 旅行日记 |
| ![](screenshots/modal-glass-light.png) | ![](screenshots/desktop-majo-diary.png) |

更多截图在 `screenshots/`。

## 目录

```
index.html          应用外壳与图标 sprite
css/base.css        布局、组件、页面、响应式
css/themes.css      四套主题 × 深浅色变量
js/data.js          演示数据（对话、语笺、日记、成就、插件、日志）
js/app.js           渲染与交互
preview.mjs         本地静态预览服务
screenshots/        最终效果截图
```

## 预览参数

调试或截图时可直接指定状态，不影响正常使用：

```
/?theme=majo|minimal|mist|glass
  &mode=light|dark|system
  &page=chat|notes|diary|achievements|market|settings
  &tab=appearance|character|model|capability|advanced|plugins|logs
  &conv=c1
```

## 与原项目的关系

- 原项目 `D:/222/ElainaChat-mod` 只被读取，源码没有被修改；可运行版本完全在本目录的 `app/` 内。
- 根目录原型使用演示数据，没有复制原项目的业务逻辑（`store.js`、`chat-stream.js`、`mods.js`、`host-slots.js` 等）。
- `app/` 是**真实逻辑副本**：包含 `web/`、`server/`、`mods/`、`skills/` 和一份 `data/` 快照；四套主题直接作用在这份副本上。
- 如果之后决定替换原项目：把 `app/web` 与 `app/server` 对齐回原仓库即可；React + Vite 重写仍然可以作为后续选项。

## 已知边界

- 模拟回复、安装状态、设置保存都只在内存 / localStorage 中，刷新后恢复演示数据。
- 语音、真实模型请求、文件导入导出、Live2D 渲染未接入。
- 字体通过 Google Fonts 非阻塞加载，加载失败时回落到系统字体，不影响布局。
