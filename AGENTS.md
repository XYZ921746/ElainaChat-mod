# AGENTS.md

## 1. 项目定位

ElainaChat-mod 是「Mod 优先」的 BYOK AI 角色聊天应用：程序本体只含**文字聊天 + Agent 能力**，角色呈现与界面由**可装可卸的扩展包（mod）**决定。
宿主不认识任何具体插件；插件只通过一份收窄的 host API 与 6 个插槽接入。

本文件规定**跨边界约定**，并包含少量**全库卫生规则**（D8 注释、D9 文档、D10 前端编辑入口）。全库规则用于防止变更史噪音与双份代码分叉，不表示所有文件内部风格都受跨边界契约约束。

## 2. 基本原则

- **契约先于实现**：跨边界约定（manifest 字段 / host API / 插槽 spec / 服务端声明）先写下来，再写代码。
- **插件优先**：新增可选功能优先做成 mod，而不是改宿主。
- **失败隔离**：一个坏插件不得拖垮应用，也不得连带废掉其它插件。
- **规则必须可判定**：每条规则都能由人或 CI 判断是否违反，禁止主观表述。判定栏不得依赖未在本文件写明的表或行号；“为什么”中的 A/B 编号仅解释背景，不构成判定依据。
- **判定自足**：若外部契约表与本文件判定栏冲突，以本文件判定栏为准，并开规则修订。

## 3. 冲突处理

- 用户当前指令与本文件冲突时，**以用户当前指令为准**。
- 但必须在回复中明确指出：「本次操作违反 AGENTS.md 的 Dxx，原因：…」。
- 不得因用户指令而**静默**绕过本文件的任何规则。

## 4. 存量违规处理

- 本文件规则自落盘之日起对**新代码**生效。
- 已知存量违规记录在 `开发文档.md` 的「规范存量违规」小节，并同步登记在本文件附录。按计划逐步清理，不要求一次性修复。
- AI 遇到存量违规时：**不主动改**，除非用户明确要求；新写代码**不得新增违规**。
- 若本次改动恰好触及某处存量违规，在 PR 描述中标注「顺带清理」或「暂不清理，原因：…」。
- **注销动作**：清理某处存量违规时，PR 必须同步更新本文件附录对应行与计数，并更新 `开发文档.md` 的「规范存量违规」小节；某条基线清零时删除附录对应行，并在 `开发文档.md` 变更史中记录「顺带清理」。

## 5. 插件边界

> 表 A/B 位于 `开发文档.md` 的「契约表」章节。A/B 编号仅解释规则背景，不构成判定依据；判定以各规则「判定」栏为准。外部表缺失或漂移时，以判定栏为准并开规则修订。

### D1 插件资源路径
- **范围**：`mods/`
- **为什么**：B1 —— `manifest.id` 与安装目录名可不一致（表 A9），自拼路径在目录改名后必然 404。
- **判定**：`mods/**/*.js` 非注释代码中出现字符串字面量 `/mods/` 拼接即违反。
- **当前违反点**：无（2026-10-30 已清理 pet / elaina-avatar / scene-backgrounds / galgame 的 `/mods/` 拼接）。

### D2 插件持久化
- **范围**：`mods/`
- **为什么**：B2 —— host 已提供 `host.storage`；直用 `localStorage` 会使数据不进同步、停用不清理。
- **判定**：`mods/**/*.js` 出现 `localStorage` 即违反。
- **当前违反点**：`mods/galgame-1.6.0/index-live2d.js`、`mods/galgame-1.6.0/index.js`、`mods/galgame-1.6.0/settings-panel.js` 中 `localStorage` 使用处。

### D3 宿主不得点名插件专有全局名
- **范围**：`web/js/`
- **为什么**：B3 —— 宿主引用插件专有全局名后，插件停用/缺失即宿主报错。
- **判定**：`web/js/**/*.js` 出现 `Live2DCall`、`ElainaLive2DModels`、`window.__live2d`、`window.__l2dm`、`window.ElainaAvatar` 即违反。
- **当前基线**：见附录；数量以最近一次专项检索输出为准，不以行号为锚点。

### D4 插件之间不得用私有全局名通信
- **范围**：`mods/`
- **为什么**：B4 —— 私有全局名使加载顺序与依赖关系不可见，且无法被检查覆盖。
- **判定**：`mods/**/*.js` 出现 `window.__` 开头的自建全局名赋值即违反。
- **当前违反点**：`mods/galgame-1.6.0/index-live2d.js`、`mods/galgame-1.6.0/index.js`、`mods/galgame-1.6.0/register.js`、`mods/galgame-1.6.0/settings-panel.js`、`mods/live2d-models-1.0.0/panel.js` 中 `window.__` 赋值处（按符号检索）。

### D5 平台分支只允许出现在存储层（含插件）
- **范围**：`web/js/`、`mods/`
- **为什么**：B6 —— 平台分支外溢会使 Web 与 APK 分裂成两套代码；现有检查只覆盖宿主。
- **判定**：检索 `isNativePlatform` / `Capacitor.isNative`；仅允许出现在 `web/js/store.js`、`server/store.mjs`、`web/js/core.js` 原生适配段，其它文件出现即违反。
- **当前违反点**：`web/js/data.js`、`mods/galgame-1.6.0/index-live2d.js` 中 `isNativePlatform` / `Capacitor.isNative` 出现处。

### D6 工厂只做注册
- **范围**：`mods/`
- **为什么**：B5 —— 工厂里发请求/起定时器/改他人 DOM 会产出「ready 但界面全无」与双份定时器。
- **判定**：检查 `window.ElainaMods.register(modId, factory)` 传入的 factory 回调体，出现 `fetch(` / `XMLHttpRequest` / `setInterval` / `setTimeout`，或对 `document.body` 或宿主元素（如 `#micBtn`）的写入，即违反。

### D7 新增插槽不得顺手新增 host API 方法
- **范围**：`web/js/`
- **为什么**：B9 —— `host-slots.js` 已明文禁止；API 面膨胀会使宿主无法重构。
- **判定**：同一 PR 中 `web/js/host-slots.js` 新增 `defineSlot` 且 `web/js/mods.js` 的 `createHostApi` 同步新增方法即违反。

> 未定型（不在本文件范围）：失败状态的**枚举命名与用户文案**（前端与宿主各有一套词汇，见表 A3/A4）尚未定型，本文件不作规定；本文件亦不区分「插槽撞名」与「地址前缀撞名」的处置粒度（见表 A10/A13）。定型后再补。

## 6. 注释与文档

### D8 注释只写「为什么」
- **范围**：全库
- **为什么**：B7 —— 变更史写进代码会让注释退化为噪音（全库存在大量分区横幅，数量见 `开发文档.md`）。
- **判定**：
  - 本次 diff 的 `.js`/`.mjs`/`.css` 新增行中出现变更史叙述词即违反。最低判定词表：`★ 20`、`用户要求`、`实测踩到`、`踩过`、`原先`、`旧版`、`改回`、`以前`、`第一版`、`已搬到`、`旧实现`、`新实现`、`迁移前`、`迁移后`、`历史原因`、`曾经`。
  - 若整行替换仅改变标识符、路径或空白，且删除行与新增行在忽略这些差异后一致，不视为新增变更史；但不得借机新增变更史内容。
  - 若本次改动改变行为、契约、设置键、manifest 字段或检查脚本数量/清单，diff 必须同时包含 `开发文档.md` 的「变更史」小节新增条目；纯注释、格式、重命名且不改变行为的改动不触发。
- **说明**：最低词表命中即违反；未命中不自动通过，评审可要求改写。

### D9 改行为不得让文档过时
- **范围**：全库
- **为什么**：B11 —— 曾出现 README「44 项检查 / 6 个扩展包」而实际检查脚本数与扩展包数都不符的漂移。
- **判定**：文档里凡出现**可数的事实**（检查脚本数、扩展包数、插槽数、脚本加载数），必须写成「以某处为准」的形式，不得写死数字；写死即违反。若本次改动**导致** README 中列出的任一数字或清单（检查项数、扩展包数、插槽表、manifest 字段表、host API 清单）**过时**，diff 必须同时包含 README 与 `scripts/` 的对应改动；缺一即违反。

### D11 manifest 新增字段必须三处同步
- **范围**：`mods/`、`server/`、`web/js/`、`scripts/`
- **为什么**：A1 —— `scripts`、`hidden`、`server` 三个字段已存在，却未进 README 字段表。
- **判定**：新增 `manifest.json` 字段时，diff 必须同时命中 README 字段表、**`server/mods.mjs` 与 `web/js/mods.js` 的校验分支（同时更新）**、`scripts/check-mod.mjs`；只改一边即违反。

（D10 见第 7 节，避免重复表述。）

### D14 宿主内部实现只能经 `window.ElainaHost` 暴露给插件系统
- **范围**：`web/js/mods.js`、`web/js/core.js`
- **为什么**：B14 —— `mods.js` 的 host API 需要借宿主内部实现（发消息、渲染 Markdown、弹窗）。若它直接 `typeof handleUserInput === 'function'` 去摸全局名，宿主一改名插件就在运行时炸，而插件作者看不到改名 —— 这正是收窄 host API 该防住的事，只是方向反了。
- **判定**：`web/js/mods.js` 中出现对下列宿主内部名的直接引用即违反：`handleUserInput`、`generateId`、`autoNameConversation`、`renderFolderList`、`updateCurrentConversationTitle`、`loadConversation`、`renderMessageText`、`showCustomAlert`、`showCustomConfirm`、`showCustomPrompt`、裸 `state`（`host().state` 除外）。新增宿主能力时，先在 `core.js` 的 `window.ElainaHost` 加 getter，再在 `mods.js` 经 `host()` 取。

### D15 宿主能力探测只能查白名单
- **范围**：`web/js/mods.js`
- **为什么**：B15 —— `host.has(name)` 早期实现是 `typeof window[name] !== 'undefined'`，等于把 window 上的一切都变成插件 API：插件能探到别的插件的私有全局名，宿主也没法据清单做兼容性判断。
- **判定**：`host.has` 的参数必须来自 `mods.js` 内 `HOST_CAPABILITIES` 的键；出现 `typeof window[…变量…]` 形式的能力探测即违反。新增能力时同时扩充 `HOST_CAPABILITIES` 与其 `capabilities()` 输出。

### D16 插槽 spec 必须在挖插槽处声明形状
- **范围**：`web/js/host-slots.js`
- **为什么**：B16 —— 插槽的 spec 形状由挖插槽一方决定，而插件是第三方写的。不声明形状时，插件少传字段的故障会推迟到渲染那一刻，报的是"xxx is not a function"，插件作者指不回自己的注册点。
- **判定**：`host-slots.js` 中每个 `defineSlot(name, impl)` 的 `impl` 必须带 `spec: { required: [...], types: {...} }` 字段；`containerSlot()` 已经内置，直接调用它的插槽视为满足。新增插槽缺该字段即违反。

### D17 禁止用 `git checkout` / `git restore` 丢弃未提交改动
- **范围**：全库（含 AI 操作）
- **为什么**：B17 —— 本项目长期存在大量**未提交**的工作区改动（改名、主题删除、契约迁移都在其中）。`git checkout -- <path>` 会把这些一次性抹掉，而且**不会出现在任何备份里**：恢复只能靠人肉重建，且往往无声无息（检查变红只报现象，不报原因）。
- **判定**：任何以丢弃改动为目的的 `git checkout --`、`git restore`、`git reset --hard`、`git stash drop` 出现在操作记录里即违反。
- **替代做法**：
  - 想撤销**自己刚刚**的改动 → 用 `edit` 精确改回，或从自己刚建的备份复制回去。
  - 想对比基线 → `git show HEAD:<path>` 只读，不写工作区。
  - 改动前先在 `%TEMP%` 里留一份副本，路径写进回复里，便于回滚。
  - 检查变红时先问「这是环境性失败还是我改坏的」，**不要**先跑 `git checkout` 归零。

### D18 host API 重成员必须按能力组下发
- **范围**：`web/js/mods.js`、`mods/**/manifest.json`
- **为什么**：B18 —— `createHostApi` 曾一次性给 20 多个成员，插件随手就能用上"很重的"那几个（注册主题模板、写宿主成就、绑全站拖拽内核），而绝大多数插件一辈子用不到。全给等于把这些重能力的维护成本摊到每个插件身上，也让"这个插件到底要什么"在清单里看不出来。
- **判定**：`HOST_API_GROUPS` 里 `core` 以外的任何组（当前 `theme` / `achievements` / `dragSort` / `openFolder`），若其成员在 `createHostApi` 中**无条件**出现在返回对象上，即违反。新增重成员时必须：① 在 `HOST_API_GROUPS` 登记组名；② 用 `...(hasGroup('组名') ? { … } : {})` 包裹；③ 更新 `开发文档.md` 表 A22；④ 用到它的插件在 `manifest.capabilities` 里声明。

### D19 服务端插件能力必须声明且取用即校验
- **范围**：`server/mod-server.mjs`、`mods/**/manifest.json`、`mods/**/server.mjs`
- **为什么**：B19 —— 插件的服务端半边是**在服务端进程里执行第三方代码**，能碰文件系统、能发网络。`routes` / `uploads` / `static` 只说了"占哪些地址、碰哪些目录"，说不清"会不会动我的磁盘"。
- **判定**：
  - `ctx` 上任何**有副作用**的成员（`utils` / `route` / `uploadDir` / `staticDir`，以及今后新增的）都必须先调 `need('<能力名>', '<成员说明>')`；缺这一行的即违反。
  - `CAPABILITY_NAMES` 之外的能力名出现在 `manifest.server.capabilities` 里，必须让 `readDeclaration` 返回 `{error}`（整份驳回），不得静默忽略。
  - `await import(server.entry)` 与 `register(ctx)` 都必须经 `withTimeout(...)`；直接 `await` 即违反。
  - 新增能力时同步更新 `开发文档.md` 表 A23。

### D20 插件失败必须自愈：隔离 + 自动停用 + 错误只落在插件卡片
- **范围**：`web/js/mods.js`、`web/js/settings.js`
- **为什么**：B20 —— 插件是用户自己装的第三方代码，装坏是常态而不是例外。它坏了必须满足三件事，缺一条就违背「失败隔离」：① **不牵连**—— 别的插件照常加载、宿主照常可用；② **不留在半启用**—— 半初始化的插件已经注册了一半插槽/样式/事件，留在界面上就是点了没反应的按钮和解释不了的样式错乱；③ **说清楚** —— 用户得知道是哪个插件、为什么、下一步做什么。
- **判定**：
  - `loadAll` 的加载循环里，`await loadOne(...)` 必须在**本循环内**的 `try/catch` 里；直接 `await loadOne(...)` 即违反。
  - 任何把 `entry.state` 置为 `'error'` 的路径（含 `loadAll` 的兜底）都必须调用 `autoDisableBroken(id, entry)`；缺即违反。
  - 自动停用必须是**写盘**的（`setModEnabled(id, false)`），不能只改内存；否则每次启动都会重试失败、刷同一批错误。
  - 失败原因必须**存进存储**（`elaina_plugin_failed_<id>`），不能只挂在内存的 entry 上：刷新后 registry 是空的，只靠内存的话重启一次就退化成普通"未启用"，原因丢失。
  - `setEnabled(id, true)` 必须区分两种重新启用：**正常停用后重启**（工厂成功跑过 → 只 `activateContributions()` 挂回注册项，**不得重跑工厂**）与**上次失败后重试**（必须清掉 `loadedScripts` 中的注入记录并重新走 `loadOne`）。把后者当前者处理即违反 —— 表现为"坏插件点几次就自己启动"，状态变 ready 而功能仍是坏的。
  - `setEnabled` 末尾**不得**无条件把状态写成 `'ready'`。状态只能由加载结果决定；`pending` 视为没有明确结论，保守判失败并停用。
  - 插件错误**只在设置 → 插件页的插件卡片上**呈现（角标 + 明文原因块）。出现下列任一即违反：把插件错误弹成全局 alert/confirm；在聊天区、顶栏、侧栏、公告等插件管理之外的位置显示插件错误；只在 `title` 悬停提示里给原因而不在卡片上明文显示（触屏没有悬停）。

## 7. 目录与编辑范围

### D10 `web/` 是唯一前端编辑入口
- **范围**：全库
- **为什么**：B13 —— `android-app/` 位于项目上一级，双份代码会分叉。
- **判定**：本次 diff 出现 `android-app/` 路径改动即违反。
- **唯一例外**：为满足 D13 而同步 `android-app/android/app/src/main/java/com/elainachat/opensource/ByokSecretsPlugin.java` 的 `ALLOWED_NAMES` 对应键；该例外不得包含该文件其他改动。

### D12 禁止新增编号文件
- **范围**：`web/js/`
- **为什么**：`web/js/` 曾用编号前缀命名 7 个核心模块（`app-01-core` … `app-07-init`），各承载 3–8 项职责，看文件名判断不出负责哪个模块；这批文件已按领域名重命名（`core`/`data`/`agent`/`ui`/`voice`/`settings`/`init`），编号命名不再允许。
- **判定**：`web/js/` 新增文件名匹配 `/^app-\d{2}-/` 即违反；新代码一律使用领域名。

## 8. 数据与设置

### D13 设置项必须三处同步 + 双写
- **范围**：`web/js/`、`server/`、`android-app/.../ByokSecretsPlugin.java`（仅 D10 例外文件）
- **为什么**：A21 —— 漏任一处会静默丢失 API Key 或使设置不落盘。
- **判定**：新增设置键时，diff 必须同时命中：
  1. `web/js/store.js` 的 `DATA_KEYS` 白名单中含 `elainachat_open_api_secrets`；
  2. `ByokSecretsPlugin.java` 的 `ALLOWED_NAMES` 中含对应键；
  3. `server/store.mjs` 的设置/密钥读写段（按文件内设置读写函数、密钥读写函数或导出名锚定，不写行号）。
  持久化落盘复用 `web/js/store.js` 的 `flush()`（导出为 `_flush`）。缺一即违反。

## 9. 验证要求

- 提交前必须运行 `npm run check`（编排 `scripts/check-*.mjs` 的全部模块，清单以 `scripts/` 实际为准）。每个模块文件内含若干命名用例，可用 `node scripts/check-<模块>.mjs <用例名子串>` 只跑其中一段，失败信息形如「用例名 :: 断言」。
- **代码性失败必须修复**。**环境性失败**指：失败信息明确为本机缺少项目 `mods/` 实物、模型文件或夹具，且同一检查在 CI 或夹具目录下通过。环境性失败必须在 PR 中记录失败脚本、原因、替代验证，并运行不依赖实物的子集；不得把代码性失败归为环境性。
- 触及插件契约的改动，额外跑 `check-mod.mjs`（内含插件扫描 / id 归一化 / 身份解析 / 依赖 / 宿主 API / 端到端六段用例）。
- 检查应优先使用临时目录/夹具隔离（`DATA_DIR` / `LOG_DIR` / `MODS_DIR`）；不得新增读写项目 `data/` 与 `mods/` 实物的检查。既有依赖实物的检查列入环境性失败清单。
- D1–D13 的「判定」栏即该规则的验证方式；新增规则按同格式补一行。

## 附录：存量违规基线

- 本附录仅登记 D1–D5 判定栏已点名的违反点。
- **不以行号为锚点**：用文件 + 可检索符号/片段定位；行号会随注释改动漂移。
- **数量**为最近一次检索计数；每次清理存量违规的 PR 必须同步更新本附录与 `开发文档.md` 的「规范存量违规」小节；清零则删除对应行。

| 规则 | 违反点（文件 + 可检索符号/片段） | 数量 | 清理优先级 |
| --- | --- | --- | --- |
| D2 | `mods/galgame-1.6.0/index-live2d.js` 中 `localStorage` 使用处 | 26 | 高 |
| D2 | `mods/galgame-1.6.0/index.js` 中 `localStorage` 使用处 | 5 | 高 |
| D2 | `mods/galgame-1.6.0/settings-panel.js` 中 `localStorage` 使用处 | 7 | 中 |
| D3 | `web/js/voice.js` 中 `Live2DCall` / `__live2d` / `__l2dm` / `ElainaAvatar` | 9 | 高 |
| D3 | `web/js/agent.js` 中同上符号 | 9 | 高 |
| D3 | `web/js/agent-tags.js` 中同上符号 | 2 | 中 |
| D3 | `web/js/mods.js` 中同上符号 | 2 | 中 |
| D3 | `web/js/data.js` 中同上符号 | 1 | 中 |
| D4 | `mods/galgame-1.6.0/index-live2d.js` 中 `window.__` 赋值 | 2 | 中 |
| D4 | `mods/galgame-1.6.0/index.js` 中 `window.__` 赋值 | 1 | 中 |
| D4 | `mods/galgame-1.6.0/register.js` 中 `window.__` 赋值 | 1 | 中 |
| D4 | `mods/galgame-1.6.0/settings-panel.js` 中 `window.__` 赋值 | 1 | 中 |
| D4 | `mods/live2d-models-1.0.0/panel.js` 中 `window.__` 赋值（`window.__l2dmRenderPanel =`、`window.__l2dmRefresh =`） | 2 | 中 |
| D5 | `web/js/data.js` 中 `isNativePlatform` / `Capacitor.isNative` | 1 | 中 |
| D5 | `mods/galgame-1.6.0/index-live2d.js` 中 `isNativePlatform` / `Capacitor.isNative` | 1 | 中 |

注：本表数量为 **2026-10-17 专项检索**输出，与 `开发文档.md` 的「规范存量违规」小节同源。
D3 上一轮记录为 29 处 / 6 文件（含 `web/js/store.js` 一行）；本轮复核结果：`web/js/store.js` 为 0 处（该行已删），
`voice.js` 3 处与 `data.js` 1 处随注释重写**顺带清理**，现为 23 处 / 5 文件。