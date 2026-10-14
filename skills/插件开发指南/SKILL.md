---
name: plugin-dev
description: 开发、审查、调试 ElainaChat 插件（mods/ 目录）时的权威指南 —— 覆盖 manifest 字段、6 个插槽、host API、生命周期、服务端半边、打包与手机端限制。当用户要写插件、改插件、排查插件加载失败或依赖缺失时使用。不用于写应用本体的普通前端代码。
---

# ElainaChat 插件开发

插件（mod）是一个**独立的扩展单位**：一个目录 + 一份清单（`manifest.json`）。
宿主不硬编码任何插件名，所以加功能不用碰主程序。

> **插件（`mods/`）与 skill（`skills/`）是两回事，不要混在一起。**
> - **插件**扩展的是**应用本身**：界面插槽、接口、资源；在 设置 → 插件 里管理、可装可卸。
> - **skill** 是**给 AI 的指令与知识**，住在项目根的 `skills/`，是纯文本，不注册到应用里、不参与运行。
>
> 本文件就是一个 skill：只讲"怎么写插件"，它自身不是插件。

权威定义只在两个文件里，其余都是用法：
- 插槽清单：`web/js/host-slots.js`
- 宿主 API 与加载器：`web/js/mods.js` 的 `createHostApi()` / `loadOne()`
- 插件的**服务端**装载规则：`server/mod-server.mjs`
- 扫描与安装：`server/mods.mjs`

## 目录结构

```text
mods/my-mod/
├─ manifest.json     # 必需：身份与能力声明
├─ index.js          # 必需：入口，用 ElainaMods.register(id, factory) 注册
├─ style.css         # 可选：自己的样式（停用时真的失效，不是藏起来）
├─ panel.js / .html  # 可选：自己的设置界面（走 settings.modal 插槽，独立成窗）
└─ server.mjs        # 可选：自己的后端接口（只有电脑版有服务端）
```

可复制的骨架在 `assets/mod-starter/`（改 id、改 `MOD_ID`、打开开关即可跑）。

## manifest.json 字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 建议 | 插件**身份**。依赖排序（`after`）按它匹配，资源 URL 也以它为准。省略时回落到目录名。合法字符：字母数字 `.` `_` `-`。**请显式写**，并尽量让 `目录名 = id = index.js 里的注册名` 三者一致 |
| `name` | 是 | 显示名（设置 → 插件 列表里看到的） |
| `version` | 是 | 语义化版本，打包产物名会带它 |
| `description` | 否 | 一句话说明 |
| `entry` | 是 | 入口脚本（相对插件目录） |
| `scripts` | 否 | 需要额外按序注入的脚本（如 `["index.js", "panel.js"]`） |
| `styles` | 否 | 自动随插件启用/停用的样式表 |
| `defaultEnabled` | 否 | 默认开关。**默认关闭是刻意的** —— 插件会改动界面，不该在用户不知情时生效 |
| `after` | 否 | 依赖的其它插件 id 数组（拓扑排序，缺依赖会明确报出来） |
| `hidden` | 否 | 不在插件列表里显示（公共资源包用） |
| `skills` | 否 | 随附的技能目录（相对插件目录，如 `["skills/foo"]`）。每个目录要有一份 `SKILL.md`；技能住在插件目录里，**删插件即删技能** |
| `server` | 否 | 服务端半边声明 `{ entry, routes, uploads, static }`（仅电脑版加载） |

> 目录名用 `isSafeModDirName` 校验（允许中文/空格，但不得以 `.` 开头、不得有尾随点/空格）。
> `manifest.id` 用更严格的 `MOD_ID_RE`。

## 随附技能（`manifest.skills`）

插件可以在清单里声明自己**随附的技能**：`"skills": ["skills/foo"]`（相对插件目录），每个目录放一份 `SKILL.md`。
这些技能文件就在插件目录内，所以 `server/mods.mjs` 卸载插件时它们**一起被删掉**，无需额外清理；
宿主会在 设置 → 插件 的「技能」区块里列出它们，并标注「来自插件 <你的 id>」。

> 技能**不是**插件：它不注册到应用里、不参与运行，只是给 AI 的指令与知识（见文件开头）。
> 本地技能放在项目根的 `skills/`，由 设置 → 插件 页里的「技能 → 上传安装」装进来。

## 能挂在哪（6 个宿主插槽）

| 插槽 | 形态 | spec |
|---|---|---|
| `settings.tabs` | 挂载一次 | `{ id, label, render(container) }`，被点开时才渲染（宿主自己的分栏用；插件默认不用它） |
| `settings.modal` | **独立设置窗** | `{ id, title, render(container) }` —— **插件设置的标准姿势**，点卡片上的齿轮打开 |
| `header.actions` | 挂载一次 | `{ id, label, title?, svg?, onClick(ev) }`，样式沿用宿主顶栏按钮 |
| `sidebar.footer` | 挂载一次 | `{ id, render(container) }` |
| `composer.actions` | 挂载一次 | `{ id, render(container) }`，容器是 `display:contents`，记得 `flex:none` |
| `chat.message.actions` | **每项级** | `{ id, render(container, { message, conversationId }) }`，宿主每渲染一条消息调一次 |

- 「挂载一次」：注册时长在界面上；停用时拆掉，启用时按同一份 spec 装回来。
- 「每项级」：你只往容器里加节点，**不要清空容器、不要碰别人的节点** —— 宿主会给你加的元素打归属标记，停用时精确摘除。
- 用 `host.slots()` 运行时取清单；插槽名写错时宿主**明确报错并列出可用插槽**，不静默失败。
- `settings.modal` 给**每个插件一块专属容器**：来回切换不串台、重开瞬开，停用即摘。

## 生命周期

| 动作 | 宿主会做什么 | 你要做什么 |
|---|---|---|
| 停用 | 收回你注册的一切：插槽内容、注入样式、system 提示词、事件订阅、消息行按钮 | 把你**自建**的界面/定时器收起来（返回对象的 `setEnabled(false)`） |
| 启用 | 按保留的 spec 装回来；**不会重跑工厂** | `setEnabled(true)` 里恢复 |
| 卸载（删目录） | 真删，spec 一并丢弃 | 无 |

**工厂只跑一次** —— 里面只做注册：别发请求、别起定时器、别改别人的 DOM，把那些放进 `setEnabled` 或事件回调。
`manifest.styles` 与 `host.injectStyle()` 注入的样式，停用时都会**真的失效**。

## host API（收窄的清单，不是把 window 丢给你）

`assetUrl` / `assetBase` / `require` / `openFolder` / `dragSort` / `getConversation` /
`getMessages` / `getUiMode` / `sendUserMessage` / `renderText` / `slot` / `slots` /
`injectStyle` / `setPromptHint` / `clearPromptHint` / `on` / `emit` / `has` /
`log` / `warn` / `error`。

两个特别说明：
- `host.require('别的插件id')` —— 取另一个插件注册时返回的 api；目标没装/没启用时返回**带原因的失败对象**，不抛异常。
- `host.dragSort(container, onDone)` —— 宿主实现的列表拖拽排序，插件列表与模型列表共用同一份。
- 取自己的资源**必须**用 `host.assetUrl('img/x.png')`，**不要**自己拼 `/mods/<id>/…` —— 声明 id 与实际安装目录名可能不同，自己拼会 404。

## 服务端半边（仅电脑版）

```json
"server": { "entry": "server.mjs", "routes": ["/api/myfirstmod"], "uploads": ["data"] }
```

- `routes` 声明你要占的地址空间，`server.mjs` 里只能注册落在这些前缀内的地址，否则装载失败并报错（声明与实现分离）。
- 不允许裸 `/api`，也不允许与宿主已有前缀（`/api/store`、`/api/agent`…）撞名。
- `uploads` 声明的目录按 `application/octet-stream` 返回（防用户上传的 `.html`/`.svg` 被同源渲染）。
- 路由在**服务启动时装载一次**：改了 `server.mjs` 要重启才生效，`/api/plugins` 会报 `needsRestart`。
- **APK 上没有服务端进程，这一半永远不加载** —— 依赖它的功能要在手机端降级。

## 打包与安装

- 装：电脑版把 `.zip` 丢进 `mods/` 后「重新扫描」自动解压；或应用内「上传安装」。手机只能应用内上传。
- 卸载：删插件目录 / 卡片上的删除按钮；装成功的 zip 会被自动清理（所以删目录是真卸载）。
- 打包发别人：仓库根跑 `npm run pack:assets`（或 `node scripts/pack-assets.mjs galgame` 只打一个）→ `dist/assets/<id>-<version>.zip`。
  约定：**插件 zip 的根目录直接是文件**（不带多余外层目录）；**模型 zip 的根目录必须是模型名那一层**。

## 手机端（APK）限制

| 能力 | 电脑版 | 安卓 APK |
|---|---|---|
| 插槽 / 样式 / 提示词 / 事件 / 消息行按钮 | 支持 | 支持（同一份代码） |
| 启用 / 停用插件 | 支持 | 支持 |
| 应用内上传安装 | 支持 | 支持（原生拦截实现） |
| 服务端半边（`server.mjs`） | 支持 | 不支持（永远不加载） |

## 调试

- `host.log()` / `host.warn()` / `host.error()` 都带 `[Mod:你的id]` 前缀，转发到 设置 → 日志 与启动窗口。
- 加载失败**不白屏**：设置 → 插件 里那一项显示「加载失败」/「前置插件不可用」，悬停看原因。
- 改 `index.js` / `style.css`：刷新页面即可；改 `manifest.json`：刷新（清单每次请求重新扫描）；改 `server.mjs`：重启服务。

## 三条铁律

1. 用 `ElainaMods.register(id, factory)` 注册，`id` 与 `manifest.json` 的 `id` 一致。
2. 只通过 factory 收到的 `host` 访问宿主能力 —— **不要**直接摸 window 上的 state / elements / 内部函数。
3. 工厂里只做注册，不要有副作用。
