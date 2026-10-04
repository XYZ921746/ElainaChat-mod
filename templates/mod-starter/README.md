# 插件模板（mod-starter）

复制这个目录就能开始写插件。**不用改项目里的任何代码。**

## 怎么用

1. 把整个目录复制到 `web/mods/` 下，并把目录名改成你的插件名：

   ```text
   web/mods/my-first-mod/
   ├─ manifest.json
   ├─ index.js
   ├─ style.css
   └─ server.mjs      ← 不需要后端就删掉，并删掉 manifest 里的 "server" 段
   ```

2. 打开 `manifest.json`，把 `id` 改成你的插件名（字母数字 `.` `_` `-`，
   **建议与目录名一致**），改掉 `name` / `version` / 描述。

3. 打开 `index.js`，改 `MOD_ID` 让它与 `manifest.json` 的 `id` **完全一致**，
   然后按注释里的五处示例增删。

4. 刷新页面 → 设置 → 插件 → 打开开关。
   （也可以把它压成 zip，用「上传安装」装——zip 里第一层就是这几个文件。）

> ★ 目录名、`manifest.json` 的 `id`、`index.js` 里的注册名三者**尽量一致**。
> 不一致时宿主会尽力对上（按目录反查注册名），但会多打一条警告 ——
> 而且这类不一致曾经造成过"装了等于没装"的真实故障。

## 文件各自干什么

| 文件 | 必需 | 作用 |
|---|---|---|
| `manifest.json` | ✅ | 身份与能力声明：id / 名称 / 入口 / 样式 / 默认开关 / 依赖 / 服务端半边 |
| `index.js` | ✅ | 入口：`ElainaMods.register(id, factory)`，所有界面与行为都在这里注册 |
| `style.css` | 否 | 自己的样式（在 manifest 的 `styles` 里列出即自动随插件启用/停用） |
| `server.mjs` | 否 | 自己的后端接口（**只有电脑版有服务端**，见下） |

## 能挂在哪（宿主插槽）

宿主目前提供 5 个插槽，全部在 `web/js/host-slots.js` 里声明 ——
**那是"我能挂在哪"的唯一权威清单**，加插槽时也只改那一个文件。

| 插槽 | 形态 | spec |
|---|---|---|
| `settings.tabs` | 挂载一次 | `{ id, label, title?, render(container) }`，**被点开时才渲染** |
| `header.actions` | 挂载一次 | `{ id, label, title?, svg?, onClick(ev) }`，样式沿用宿主顶栏按钮 |
| `sidebar.footer` | 挂载一次 | `{ id, render(container) }` |
| `composer.actions` | 挂载一次 | `{ id, render(container) }`，容器是 `display:contents`，记得 `flex:none` |
| `chat.message.actions` | **每项级** | `{ id, render(container, { message, conversationId }) }`，每条消息调一次 |

用 `host.slots()` 可以在运行时取到这份清单。插槽名写错时宿主会**明确报错并列出可用插槽**
（写在浏览器控制台里），不会静默失败。

### 两种形态的区别（写插件时最容易搞错的地方）

- **挂载一次**：注册时就长在界面上。停用插件时宿主会把它拆掉，重新启用时按同一份 spec 装回来。
- **每项级**：注册时界面里可能还没有"项"（一条消息都还没有），所以那时**什么都挂不上**是正常的。
  宿主每渲染一项就调一次你的 `render`。你只管往容器里加节点，
  **不要清空容器、不要碰别人的节点** —— 宿主会给你加进来的元素打上归属标记，
  停用插件时精确摘除它们。

## 生命周期（三条，与"停用要真的停用"有关）

| 动作 | 宿主会做什么 | 你要做什么 |
|---|---|---|
| 停用 | 收回你注册的一切：插槽内容、注入的样式、system 提示词、事件订阅、消息行按钮 | 把**你自建**的界面/定时器收掉（在返回对象的 `setEnabled(false)` 里） |
| 启用 | 按保留的 spec 把你注册的东西装回来；**不会重跑工厂** | 同上，`setEnabled(true)` 里恢复 |
| 卸载（删插件） | 真删，spec 一并丢弃 | 无（进程里脚本还在，但不再有任何注册） |

**工厂只会跑一次。** 所以工厂里只做注册，别发请求、别起定时器、别改别人的 DOM ——
把那些放进 `setEnabled` 或事件回调里。

`manifest.json` 里声明的 `styles` 与你自己调 `host.injectStyle()` 注入的样式，
停用时都会**真的失效**（不是只藏起来）。

## 服务端半边（`manifest.json` 的 `server` 段）

```json
"server": {
  "entry": "server.mjs",
  "routes": ["/api/myfirstmod"],
  "uploads": ["data"]
}
```

- `routes` 声明你**要占的地址空间**；`server.mjs` 里只能注册落在这些前缀之内的地址，
  否则装载失败并报错（声明与实现必须一致，用户看清单才知道插件要占哪些地址）。
- 不允许裸 `/api`，也不允许与宿主已有前缀（`/api/store`、`/api/agent`…）撞名。
- `uploads` 里声明的目录会被宿主按 `application/octet-stream` 返回 ——
  用户上传的 `.html`/`.svg` 不会被同源渲染。
- **改了 `server.mjs` 要重启服务才生效**（路由是启动时装载的常驻注册表）。
  `/api/plugins` 会把这种情况报成 `needsRestart`。

## ★ 手机上（APK）的限制

| 能力 | 电脑版（Web） | 安卓 APK |
|---|---|---|
| 插槽、样式、提示词、事件、消息行按钮 | ✅ | ✅ 同一份代码 |
| 启用 / 停用插件 | ✅ | ✅ |
| **安装**自己的插件（上传 zip） | ✅ | ❌ 没有服务端、碰不到文件系统 |
| **服务端半边**（`server.mjs` 的接口） | ✅ | ❌ 没有服务端进程，这一半永远不加载 |

所以：**依赖 `server.mjs` 的功能要在手机上降级**（先判断接口通不通，不通就提示改用电脑版）。
另外手机上只能启用/停用**构建时打包进去**的插件，装不了自己新写的。

## 调试

- `host.log()` / `host.warn()` / `host.error()` 都会带上 `[Mod:你的id]` 前缀，
  并转发到**设置 → 高级 → 日志查看器**，以及启动窗口。
- 插件加载失败不会白屏：设置 → 插件 里那一项会显示「加载失败」/「前置插件不可用」，
  鼠标悬停能看到原因。
- 改了 `index.js` / `style.css`：刷新页面即可。
  改了 `manifest.json` 或 `server.mjs`：前者刷新即可（清单每次请求重新扫描），后者要重启服务。
- 打包发给别人：在仓库根目录跑 `npm run pack:assets` ——
  它会把 `web/mods/` 下的插件逐个打成 `dist/assets/<id>-<version>.zip`，
  这个 zip 就是别人可以「上传安装」的包（zip 里不带多余的外层目录）。
