# Live2D 引擎与模型

Live2D 的**运行引擎**与**模型资源**。不提供界面，被「Live2D 视频通话」依赖。

## 里面有什么

```text
live2d-models/
├─ vendor/    引擎：live2dcubismcore + pixi-6 + pixi-live2d-display（787 KB）
└─ models/    模型：内置 2 个（deepseek / 伊蕾娜·默认），用户上传的也放这里
```

**为什么引擎和模型放一起**：两者有版本耦合（Cubism Core 决定能加载哪些 `.moc3`），
而且都要被复用 —— 视频通话用它，将来的桌宠也会用它。放在一个资源包里，
复用方只要 `host.require('live2d-models')` 就能同时拿到引擎与模型。

**为什么单独一个插件**：资源与代码分开。模型可以独立更新（动辄 6.7 MB，不该跟代码一起发版），
卸掉视频通话也还能留着模型。

## 引擎是按需加载的

三个库合计 787 KB，**只在真正打开视频通话时才注入** —— 不装 Live2D 的用户不必为它付代价。
注入顺序由本插件保证（core → pixi → display，最后一个在求值时就要求前两个已存在）：

```js
await window.ElainaLive2DModels.ensureEngine();   // 可重复调用，只加载一次
```

## 对外接口

挂在 `window.ElainaLive2DModels`，其它插件也可以直接用：

| 方法 | 说明 |
| --- | --- |
| `list()` | 列出模型（含 modelJson / exps / motions / vtube） |
| `baseUrl(name, bundled?)` | 模型资源基址（结尾带 `/`） |
| `assetUrl(name, rel, bundled?)` | 模型内某个文件的 URL |
| `ensureEngine()` | 确保引擎就绪（懒加载；并发调用只加载一次） |
| `engineReady()` | 同步探测引擎是否已就绪 |

## 服务端接口

四个接口，路径与拆分前完全一致（前端不用改）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/live2d/models` | 列出模型 |
| POST | `/api/live2d/upload` | 上传 zip，解压成一个模型目录 |
| DELETE | `/api/live2d/models/<名>` | 删除模型目录 |
| POST | `/api/live2d/rename` | 重命名（目录名即显示名） |

模型文件住在 `models/`，通过 `manifest.server.static` 映射到 URL `/live2d/models/` ——
**URL 不变、磁盘位置归插件自己**。引擎目录同理映射到 `/live2d/vendor/`，
但它声明了 `"mime": "auto"`（按真实 MIME 返回，否则浏览器会拒绝执行脚本）；
`models/` 走默认的二进制流（那是用户上传的内容，防同源 XSS）。

## 模型怎么放

- **应用内**：设置 → Live2D → 上传 `.zip`（推荐，手机也能用）
- **手动**：把解压后的模型目录放进 `models/`，然后刷新页面

> `models/` 里的文件**不入库**（见 `.gitignore`）—— 模型走 Releases 分发。

## 已知限制

- 上传大 zip（>50 MB）时内存占用较高（整包读入内存）
- 模型目录名即显示名，改名会真的重命名文件夹
