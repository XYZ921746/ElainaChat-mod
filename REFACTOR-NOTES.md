# 重构工作区（refactor）—— 最终报告

## 目录关系
- 原始目录：`D:\222\ElainaChat-mod` —— **零改动**（仅被读取）。
- 重构目录：`D:\222\refactor` —— 可独立运行的完整副本。
- 补入：`dist/Android/scripts/sync-web.mjs`（check-mod / check-ui 的共享模块闭包检查需要）。

## 运行 / 验证
```powershell
node scripts/run-checks.mjs                                  # 全量：PASS 2860 / FAIL 0
$env:OPEN_BROWSER='0'; $env:PORT='3997'; node start.mjs       # 启动（勿与 3999 原实例抢端口）
```
冒烟：`/` 200、`/js/settings.js` 200、`/js/init.js` 200、`/js/chat-backup.js` 200、`/api/plugins` 200。

## 已完成批次（仅改本目录）
| 批次 | 文件 | 改动 |
| --- | --- | --- |
| 批1 | web/js/init.js | 3 处重复 `setHint` → 文件级 `setHintText` |
| 批2 | web/js/mcp.js | `doRegisterMcpOps` 双层循环 → `makeToolExec` / `registerOneTool` |
| 批3 | web/js/store.js | 抽出 `reportSaveFailed` / `mergeLoadedData` / `applyRemotePatch` |
| 批4 | web/js/log-viewer.js | `exportLogs`(136) → `collectExportEntries` / `buildExportText` / `saveExportText` |
| 批5 | server/mcp-http-client.mjs | SSE 消息处理抽 `handleSseMessage`，压平 4 层嵌套 |
| 批6 | web/js/settings.js | `refreshModsList` 707→454；`renderModCard`/`renderGroupHtml`/`rippleCard`/`escAttr`/`ICON` 上移 |
| 批7 | web/js/init.js | `init()` 1288→982；模型组合框 7 函数 + `syncExtMenuParent` 上移（逐函数 normalize 与原体一致） |
| 批8 | web/js/data.js | `saveMemoryCoreFromSummary` 3 个布尔参数 → options 对象 |
| 批9 | web/js/settings.js | `refreshModsList` 454→403；抽出 `loadModsEntries`/`splitPrereqMods`/`computeTopOrder` |
| 批19 | server/store.mjs | 抽 `parseSettingsObject(obj)`，`splitVoiceSamples` / `joinVoiceSamples` 共用同一份“取设置 JSON”逻辑 |
| 批18 | server/skills.mjs | `scan` 拆成 `scanLocalSkills()` / `scanModSkills()`（本地技能 / 插件随附技能），主函数只合并 |
| 批17 | server/mods.mjs | `scanAndSync` 抽 `buildPluginList(installed)`（清单映射）与 `writeIndexFile(list)`（原子串行写 index.json） |
| 批16 | server/store.mjs | `parseBackup`(126 行) → `extractZipData(files)` / `restoreVoiceSamplesFromZip(files)` / `parseLegacyJsonBackup(buf)` + 薄编排 |
| 批15 | server/store.mjs | `exportZip`(99 行) → `buildExportManifest` / `buildExportSettings` / `buildExportCharacters` / `buildExportConversations` / `buildExportMemory` / `buildExportVoiceSamples` + 编排 |
| 批14 | server/relay.mjs | `handleRelay` 抽 `resolveRelayTarget(request,response,payload)` / `buildForwardHeaders(payload)`（均定义在 createRelay 闭包内，保留 deps 注入） |
| 批11 | server/store.mjs | 抽 `isClassifiedKey(k)`，消除 3 处“排除归类键”重复（saveStore / 迁移 / exportZip） |
| 批12 | web/js/settings.js | `refreshMcpList` 抽 `renderMcpCard(srv,index,statusMap)` |
| 批13 | web/js/settings.js | `refreshSkillsList` 抽 `renderSkillCard(s)`，并复用 `ICON.doc/trash` 去掉重复 SVG 常量 |
| 批10 | web/js/chat-backup.js | `buildBackupBlob`(77) → 5 个 section 构建器 + 编排 |
| 批22 | web/js/agent.js → agent-search.js | 拆出 AI 联网搜索（261 行：服务商调用 / 失败分类 / 自动换家 / 结果格式化），index.html 在 agent.js 后加载；check-browser 改为拼读两个文件 |
| 批20 | web/js/store.js | 修：`bootstrap()` 记 `backendKind`，`subscribeRemote` 不再比较对象身份（APK 判断生效） |
| 批21 | web/js/settings.js | 修：`modsHintErrorText` 只清理“上一轮自己写下的”安装失败提示 |
| 批23 | web/js/mods.js | `createHostApi` 517→20 行：按 `HOST_API_GROUPS` 拆出 `coreHostApi` / `openFolderHostApi` / `dragSortHostApi` / `themeHostApi` / `achievementsHostApi`；重成员仍只在 `hasGroup(...)` 为真时合并 |
| 批24 | web/js/settings.js | `refreshModsList` 403→114 行：抽出 `bindPrereqToggle` / `bindModToggle` / `bindModCardButtons` / `bindModGroupActions` |
| 批25 | server/browser.mjs | `createBrowserSession` 299→284 行：抽出纯函数 `browserLaunchArgs` / `parseDevToolsActivePort` / `parseCdpMessage` / `parseEvaluation` |
| 批26 | server/mcp-client.mjs | `createMcpClient`：抽出 `buildInitializeParams` / `wireChildProcess` / `normalizeToolList` / `flattenToolResult` |
| 批27 | server/mcp-http-client.mjs | `createMcpHttpClient`：抽出 `translateRequestError` / `buildInitializeParams` / `applyNegotiatedVersion` / `flattenToolResult` |
| 批28 | server/relay.mjs | `createRelay` 318→230 行（`handleRelay` 163→75 行）：抽出 `createRelayAbort` / `relayTimeoutMs` / `readRelayBody` / `buildRelayFetchOptions` / `formatRelayFailure` / `writeUpstreamHeaders` / `forwardUpstreamBody`，空闲续期与总时长硬顶语义不变 |
| 批29 | web/js/data.js | `buildLayeredRoleplayMessages` 192→163 行：抽出 `buildRoleplayMemoryMessage` / `buildRoleplayImageMessage` / `buildRoleplayVoiceJpMessage` / `buildRoleplayModHintMessages` / `buildRoleplayUserContent`，提示词文本与 push 顺序不变 |
| 批30 | web/js/ui.js | `openCustomModal` 186→107 行：抽出 `setupModalInput` / `renderModalPresets` / `bindModalInputKeys`，弹窗输入/模板/键盘行为不变 |
| 批31 | web/js/ui.js | `renderTurnProcess` 194→106 行：抽出 `buildTurnSummaryEntry` / `buildTurnReasoningEntry` / `buildTurnPhaseEntry` / `buildTurnToolEntry`，增量渲染与滚动快照逻辑未动 |
| 批32 | web/js/mods.js | `bindFlatDragSort` 405→279 行：抽出 `buildFlatDragSnapshot` / `flatDragIdOf` / `flipDragLayout` / `pickDragInsertTarget` / `computeActiveParent` / `restoreDraggedCard`；拖拽状态机与监听时序未动 |
| 批33 | web/js/mods.js、web/index.html、web/js/settings.js | 修拖拽观感：卡片留在原 DOM（保留设置页配色/字号/内边距），临时停掉面板 transform/animation；去掉 scale(1.02)/背景/透明度；FLIP 结束清理内联 transition |
| 批34 | web/index.html | 修插件/技能/MCP 列表首行不等高：去掉容器的 `space-y-2`（它给第二张起加 `margin-top:8px`，与网格 gap 叠加，导致第二列矮 8px、下移 8px） |
| 批35 | web/js/mods.js | 修拖完设置闪一下：拖拽期间不再把面板 `animation` 设为 `none`（还原会重播入场动画），改为临时 `animation-fill-mode:none` |
| 批36 | server/zip.mjs | `readZip` 116→52 行：抽出 `readCentralEntries` / `readLocalEntries` / `extractEntryContent`；中央目录回退、路径/扩展名/体积拦截与错误文案不变 |
| 批37 | web/serve.mjs | `mcpServersFromSettings` 15 行 + 抽 `normalizeMcpHeaders` / `normalizeMcpServer`；`agentWrite` 86→19 行，抽 `readAgentWriteBody` / `rejectBlockedWriteTarget` / `confirmAgentWrite` / `ensureWriteParent`；`agentDelete` 110→60 行，抽 `rejectDeleteTarget` / `deleteFailureReason`；状态码、字段名、错误文案与确认时序不变 |
| 批38 | server/store.mjs | `saveStore` 45→20 行：抽出 `writeClassifiedStore`（记忆/卡/对话）与 `writeMiscStore`（其余键 + 参考音频拆分）；串行写队列、缓存戳更新与抛错语义不变 |
| 批39 | server/mod-server.mjs | `readDeclaration` 77→32 行：按 routes / uploads / static 拆出 `readRoutePrefixes` / `readUploadDirs` / `readStaticMappings`；`loadOne` 200→100 行：ctx 构造抽成 `createModContext`；能力守卫、声明校验顺序与回滚逻辑不变 |
| 批40 | server/backup-packages.mjs、server/auth-guard.mjs、server/activity.mjs | 备份收集去重为 `collectPackage`；密码弱口令段抽 `weakPasswordMessage`；活动采集解析抽 `parseForegroundOutput` / `parseProcessOutput`；文件顺序、错误文案与缓存语义不变 |
| 批41 | web/js/ui.js、web/js/settings.js | `renderDiaryPage` 109→30 行，抽 `groupDiaryEntries` / `createDiaryGroupHead` / `createDiaryCard`；`createConversationItem` 130→19 行，抽 `conversationPreviewText` / `conversationItemMarkup` / `bindConversationItemEvents` / `bindConversationLongPress`；`applyTurnProcessEntries` 100→18 行，拆 `rebuildTurnProcess` / `updateTurnProcessRows`（appendData 快路径与滚动快照原样保留）；`editMcpServer` 189→97 行，抽 `makeMcpTestAction` / `mcpEditorDefaultValue` / `importMcpServersShell`；DOM 类名、事件时序、弹窗文案与导入行为不变 |

审查后判定**无需改**：`web/js/theme.js`、`web/js/achievements.js`、`server/log-buffer.mjs`、`server/http-util.mjs`。

## 最终验证证据（第四轮复跑）
1. **changes-all.diff 覆盖 32 个文件**：15 个前端源文件（含新增 `web/js/agent-search.js`）、15 个服务端源文件、3 个检查脚本、1 个开发文档；原目录保持零改动。
   - `mods/index.json` 是服务端扫描时重写的运行产物，已从原目录还原（sha256 一致），保证副本忠实。
2. **全量校验（串行）**：`node scripts/run-checks.mjs --serial` → **PASS 2860 / FAIL 0**（13 模块全绿，113.9s）。
3. **分项**：check-mod 371/0、check-ui 297/0、check-browser 235/0、check-data 295/0、check-stream 222/0、check-frontend 32/0、check-log 232/0、check-security 193/0。
4. **启动冒烟**（PORT=3997，OPEN_BROWSER=0）：`/`、`/js/settings.js`、`/js/init.js`、`/js/ui.js`、`/api/plugins`、`/api/skills`、`/api/data/info` 全部 200；测后 3997 端口已释放，mods/index.json 已还原。

## 手机 / APK 适配
改动文件的原生标记（Capacitor / isNativePlatform / IS_NATIVE_APP / ElainaExport / Filesystem /
EXTERNAL_STORAGE / CACHE / Android）逐文件计数一致：init 10→10、mcp 1→1、store 代码分支一致、
log-viewer 分支行行对应、settings 40→40、data 11→11。所有 APK 分支原样保留，只是被搬进更小的函数。

## 发现的问题（只报告，未改）
1. ✅（已修复，见下方 2026-10-29 修复条）`web/js/store.js` `subscribeRemote` 的平台判断恒 false。
2. ✅（已修复）`web/js/settings.js` `refreshModsList` 的 `#modsHint` 旧提示残留。
3. `refreshModsList` 每次整块 `innerHTML` 重建，且每次都 `void refreshSkillsList()` 重新拉技能（性能隐患）。

## 高风险 / 未做（需你确认）
- **参数对象化剩余项**：`postJsonFromDevice(url,body,headers,timeoutMs,signal)`（11 调用点）、
  `requestChatJson(...)`（4 调用点，chat-providers）——改签名波及面大且牵动 check-chat 的假实现。
- **模块拆分**：`mods.js`(3213) / `core.js`(3054) / `agent.js`(4117) 拆文件——触及插件契约与加载顺序。
- `web/js/ui.js`、`agent.js` 的其余长函数：被静态检查按函数名/代码片段锚定，改动风险高于收益。
  特别是 `agent.js` 的 `continueAgentLoop` / `doAgentFile` / `explainAgentFailure` / `handleUserInput` 等会被
  `check-agent` 用 `extractFn` 抠出函数体单独编译执行；一旦从这些函数里再抽子函数（子函数不在被抠出的上下文里），
  测试会直接 ReferenceError。故这些**刻意不动**。

## 关于“参数对象化 / 模块拆文件”（2026-10-29 更新：检查已获准修改）
- **postJsonFromDevice / requestChatJson 参数对象化：已完成**（见下方 2026-10-29 条目）。
- **requestChatJson**：检查只断言 `async function requestChatJson(`（`check-stream.mjs` 319 行），技术上可改；
  为保持与 `postJsonFromDevice` 统一风格、避免“半套改动”，本轮**未动**。
- **mods.js / core.js 拆文件：未做（架构约束）**。
  · `mods.js` 是**单个 IIFE**，146 个函数共享同一份闭包状态（registry / 存储 / 生命周期 / 拖拽内核）；跨文件拆必须把内部状态挂到全局或新命名空间，属于架构改造而非行为等价重构。
  · `core.js` 同样以文件级函数 + 原生适配段紧耦合，且大量检查按 `core.js` 文件名锚定。
  · `agent.js` 已拆出 `agent-search.js`（可行部分，见批 22）。
- 其余原判断仍成立：
  · `check-mod.mjs` 把 `web/js/mods.js` 读进 vm 沙箱执行并断言 `HOST_API_GROUPS` 等 —— 拆出去后沙箱只剩半个模块；
  · `check-agent.mjs` 用 `extractFnFrom(agent.js, name)` 抠函数体单独执行 —— 函数搬家即找不到；
  · `readFrontend()` 按 index.html 的 `<script>` 顺序拼接源码，新增脚本顺序不对会让大量 `indexOf` 断言静默失真。
  → **未拆**；可做的替代是“文件内拆函数”，已在多处完成。

## 2026-10-29 两处 Bug 修复（行为变更，已同步 开发文档 变更史）
- `web/js/store.js`：`bootstrap()` 记录 `backendKind`，`subscribeRemote` 改用它判断“是否 APK”，
  修掉 `backend === createNativeBackend()` 恒 false 导致“APK 不建 SSE”失效的问题。
- `web/js/settings.js`：新增 `modsHintErrorText`，`refreshModsList` 只在“提示仍是上一轮自己写的安装失败”时清空，
  既不再残留旧错误，也不会抹掉上传/开关刚写下的新提示。

## 2026-10-29 参数对象化（已获准改检查）
- `web/js/core.js`：
  · `postJsonFromDevice(url, body, headers = {}, { timeoutMs = 120000, signal = null } = {})`
  · `requestChatJson(endpoint, body, headers, { format, ...opts } = {})`
- 调用点全部更新：`core.js` 内部 3 处、`agent.js`、`init.js` 2 处、`settings.js`、`voice.js` 2 处、`chat-providers.js` 4 处。
- 检查同步（**只改判据，不改数量**）：
  · `scripts/check-chat.mjs` 的逐字签名断言 → 断言 options 对象 + `signal?.aborted`；
  · `scripts/check-stream.mjs` 的“5 个形参”断言 → 断言 `{ timeoutMs, signal } = {}` 仍在。
- 验证：全量 **PASS 2860 / FAIL 0**。

## TypeScript 评估
前端无打包器、服务端共享模块按文件名被 check-mod 锁定 → 运行时暂不引入 TS；
可在纯逻辑叶子模块用 `// @ts-check` + JSDoc 做零运行时类型检查（待确认）。

## 2026-10-29 第三轮（批23–27，继续重构）

- `web/js/mods.js`：`createHostApi` 517 → 20 行（只做能力组解析与按组拼装），
  拆出 `coreHostApi` / `openFolderHostApi` / `dragSortHostApi` / `themeHostApi` / `achievementsHostApi`。
  core 37 个成员 + 四个重成员；重成员仍只在 `hasGroup(...)` 为真时合并，D18 / 表 A22 契约不变。
- `web/js/settings.js`：`refreshModsList` 403 → 114 行，事件绑定移入
  `bindPrereqToggle` / `bindModToggle` / `bindModCardButtons` / `bindModGroupActions`（同文件顶层函数，沿用既有风格）。
- `server/browser.mjs`：`createBrowserSession` 299 → 284 行，抽纯函数
  `browserLaunchArgs` / `parseDevToolsActivePort` / `parseCdpMessage` / `parseEvaluation`。
- `server/mcp-client.mjs`：抽 `buildInitializeParams` / `wireChildProcess` / `normalizeToolList` / `flattenToolResult`。
- `server/mcp-http-client.mjs`：抽 `translateRequestError` / `buildInitializeParams` / `applyNegotiatedVersion` / `flattenToolResult`。
- `server/relay.mjs`：`createRelay` 318 → 230 行（`handleRelay` 163 → 75 行），抽 `createRelayAbort` / `relayTimeoutMs` / `readRelayBody` / `buildRelayFetchOptions` / `formatRelayFailure` / `writeUpstreamHeaders` / `forwardUpstreamBody`；空闲续期 + `RELAY_TIMEOUT_MAX` 硬顶语义不变。
- `web/js/data.js`：`buildLayeredRoleplayMessages` 192 → 163 行，抽 5 个提示词段构建器；`agentPhoneSkillText()` 仍留在主函数内（check-agent 的源码判据），文本与顺序未变。
- `web/js/ui.js`：`openCustomModal` 186 → 107 行，抽 `setupModalInput` / `renderModalPresets` / `bindModalInputKeys`；闭包状态仍由主函数持有。
- `web/js/ui.js`：`renderTurnProcess` 194 → 106 行，抽 4 个条目描述符构建器；`applyTurnProcessEntries`、滚动快照、`stickChatScrollToBottom` 均未动（check-stream 的源码锚点全保留）。
- `web/js/mods.js`：`bindFlatDragSort` 405 → 279 行，抽出 `buildFlatDragSnapshot` / `flatDragIdOf` / `flipDragLayout` / `pickDragInsertTarget` / `computeActiveParent` / `restoreDraggedCard`；拖拽状态机、监听时序、CSS 类名原样保留。
- 拖拽观感修复（批33）：拖拽中的卡片不再挂到 `body`（那会丢掉 `#settingsContent` 的配色/字号/内边距），改为留在原 DOM + 临时停掉设置面板的 transform/animation；去掉 `scale(1.02)`、背景/透明度/毛玻璃，尺寸与拖拽前完全一致；FLIP 结束后清理内联 transition。
- 列表等高修复（批34）：`#modsList` / `#skillsList` / `#mcpList` 去掉 `space-y-2` —— 网格本身已有 `gap:12px`，而 `space-y-2` 又给第二项起加 `margin-top:8px`，使首行第二张比第一张矮 8px、下移 8px。
- 拖完闪一下修复（批35）：拖拽期间把面板 `animation` 设为 `none` 再还原，会让浏览器从头重播 `modal-pop`；改为只临时设 `animation-fill-mode:none`（不动 `animation-name`），实测拖拽全程 `animationstart` 为 0。
- 后端 zip（批36）：`server/zip.mjs` 的 `readZip` 116 → 52 行，抽出 `readCentralEntries` / `readLocalEntries` / `extractEntryContent`；安全拦截与错误文案逐字保留。
- 约束：原目录 `D:\222\ElainaChat-mod` 仍零改动；本轮曾因 `os.tmpdir()` 在空环境下返回 `undefined\temp`
  把备份写进原目录，已整体移到 `D:\222\_refactor-backup\stray-undefined-20261029-1310`（未删除内容）。
- 验证：`node scripts/run-checks.mjs --serial` → **PASS 2860 / FAIL 0**（13 模块全绿，113.1s；check-mod 计数偶发 370/371，均为 0 失败）；
  分项：check-mod 371/0、check-ui 297/0、check-browser 235/0、check-data 295/0、check-stream 222/0、check-frontend 32/0。

## 2026-10-29 第四轮（批37–41，后端优化 + 前端剩余候选）

### 后端
- `web/serve.mjs`：
  · `mcpServersFromSettings` 抽 `normalizeMcpHeaders` / `normalizeMcpServer`（只保留字符串/数字请求头、空配置二次过滤的语义不变）。
  · `agentWrite` 86 → 19 行：抽 `readAgentWriteBody`（1MB 上限、413/400 文案原样）、`rejectBlockedWriteTarget`（web/ 内危险扩展名拦截）、`confirmAgentWrite`（strict 下 needCreate / needOverwrite，403 字段不变）、`ensureWriteParent`。
  · `agentDelete` 110 → 60 行：抽 `rejectDeleteTarget`（盘符根 / 项目根 / web 根 / 系统目录 / Program Files 的拒绝顺序与文案不变）与 `deleteFailureReason`（EBUSY/EPERM/ENOTEMPTY/ENOENT 映射不变）。
- `server/store.mjs`：`saveStore` 45 → 20 行，抽出 `writeClassifiedStore`（记忆 / 人设卡 / 对话）与 `writeMiscStore`（其余键 + 参考音频拆出）；仍走同一 `writeQueue`，失败上抛与 `cacheStamp` 更新语义不变。
- `server/mod-server.mjs`：`readDeclaration` 77 → 32 行，按 routes / uploads / static 拆出 `readRoutePrefixes` / `readUploadDirs` / `readStaticMappings`，校验顺序保持 routes → uploads → static → capabilities；`loadOne` 200 → 100 行，ctx 构造抽成 `createModContext`，四个副作用成员的 `need(...)` 守卫原样保留。
- `server/backup-packages.mjs`：mods / skills 两段重复收集合并为 `collectPackage(rootDir, isSafeName, prefix, requireSkill)`，条目顺序不变。
- `server/auth-guard.mjs`：弱口令精确命中 + 前后缀变体检查抽成 `weakPasswordMessage(lower)`，强度规则与文案不变。
- `server/activity.mjs`：前台窗口 / 进程列表的输出解析抽成 `parseForegroundOutput` / `parseProcessOutput`，PowerShell 脚本与缓存策略未动。

### 前端
- `web/js/ui.js`：
  · `renderDiaryPage` 109 → 30 行：抽 `groupDiaryEntries` / `createDiaryGroupHead` / `createDiaryCard`，分组顺序、`diary-group-*` 类名、点击筛选与详情弹窗行为不变。
  · `createConversationItem` 130 → 19 行：抽 `conversationPreviewText` / `conversationItemMarkup` / `bindConversationItemEvents` / `bindConversationLongPress`，DOM 结构、事件监听顺序、长按阈值 520ms / 位移 9px 不变。
  · `applyTurnProcessEntries` 100 → 18 行：慢路径拆 `rebuildTurnProcess`（整体重建 + 展开态 / 行内滚动快照），快路径拆 `updateTurnProcessRows`（版本比对、思考行 appendData、单行 outerHTML 替换）；`__elainaRows` 版本记录留在主函数。
- `web/js/settings.js`：`editMcpServer` 189 → 97 行：测试连接按钮抽 `makeMcpTestAction`、默认 JSON 编辑器内容抽 `mcpEditorDefaultValue`、多台导入抽 `importMcpServersShell`；提示文案、状态行、id 去重与停旧连接顺序不变。

### 验证
- 单文件 `node --check`：serve.mjs、store.mjs、mod-server.mjs、backup-packages.mjs、auth-guard.mjs、activity.mjs、ui.js、settings.js 全部通过。
- 分项：check-security 193/0、check-data 295/0、check-log 232/0、check-mod 371/0、check-ui 297/0、check-browser 235/0、check-stream 222/0。
- 串行全量：`node scripts/run-checks.mjs --serial` → **PASS 2860 / FAIL 0**（13 模块全绿，113.9s）。
- 备份：本轮改动前的 6 个后端源文件在 `D:\222\_refactor-backup\backend-20261029110205\`。

## 2026-10-30 第一步：Agent 纯解析函数拆分（检查先行）
- **先升级检查**：`scripts/check-agent.mjs` 新增用例「Agent 纯解析函数（agent-parse.js）」——`vm.runInContext` **整脚本装载** `agent-parse.js`，再逐个调用函数断言 9 条。这样以后在这些函数之间再加 helper，不会因为“只抠单个函数体”而 ReferenceError（假红）。
- **只拆无状态函数**：`web/js/agent.js` 中 7 个无 state/DOM/网络副作用的函数（`recallDateHintOf` / `recallDiaryDateMatches` / `recallExcerpt` / `parsePhoneOperation` / `describePhoneOperation` / `parseBrowserTag` / `summarizeBrowserArgs`）与 `AGENT_PHONE_OPS` 常量搬到新文件 `web/js/agent-parse.js`；`index.html` 在 `agent.js` 之前加载；`agent.js` 不再重复定义。
- **检查同步**：`scripts/check-browser.mjs` 的 `AGENT_SOURCES` 纳入 `agent-parse.js`（标签解析用例仍能找到 `parseBrowserTag`）。
- **文档同步**：`开发文档.md` 第 3 节前端模块表新增 `agent-parse.js`（编号顺延）。
- **不拆**：`core.js` / `mods.js` / `agent.js` 本体仍不拆——它们分别是全局能力表、单 IIFE 共享闭包、按函数名被检查锚定；拆文件只会把隐性契约变成显性风险，收益不如继续做检查覆盖与边界收敛。
- **验证**：`node scripts/run-checks.mjs --jobs 6` → **PASS 2887 / FAIL 0**（check-agent 408、check-browser 237、check-data 303、check-mod 379）。

## 2026-10-30 检查层局部重构（只改检查，不改产品）
- 新建 `scripts/check-source.mjs`：统一 `extractFunction` / `extractClass` / `stripComments` / `makeVmSandbox` / `runClassicScripts`。
- 迁走 6 份复制品：`check-agent` / `check-chat` / `check-ui` / `check-mod` / `check-stream` / `check-security` / `check-browser`。
- 关键：源码抽取现在会跳过字符串 / 模板串 / 注释，并**识别正则字面量**；`check-frontend` 新增「检查工具自身」7 条毒样本断言。
- 发现的真缺陷：旧花括号配对会被 `/filename="?([^";]+)"?/` 里的引号带跑，把 `exportDataBackup` 抽成 2186 行（含文件后续代码），于是 `check-security` 的「没有用 location.href」断言长期假绿。修好后函数抽取为 87 行、无 `location.href`，断言恢复真实。
- 不做：不按行数拆 `check-mod` / `check-ui` 等大文件；只做工具层收敛。
- 验证：全量 **PASS 2894 / FAIL 0**；check-frontend 39、check-security 193、check-browser 237、check-mod 379（安装结果计数偶发 378，已知抖动）。

## 2026-10-30 检查层 B 步（执行型用例迁移，24 处 / 剩余 3 处）
- `check-source.mjs` 新增 `extractTopLevelFunctions(source)` / `extractVariable(source, name)`：取“整个模块的顶层函数环境”，不再只抠目标函数。
- `check-stream`：思考参数用例改为 `core.js` 全部顶层函数 + `THINKING_EFFORTS` 常量装进 VM。
- `check-browser`：`parseBrowserTag`（整脚本 `agent-parse.js`）、`createLineSplitter`（直接 import ESM）、`SEARCH_PROVIDERS`（`extractVariable`）、`parseLooseSearchPayload`（`core.js` 函数环境）、`formatSearchResult`（`agent-search.js` 函数环境）、`extractReplyTags`（`agent-tags.js` + `data.js` 函数环境）、`opName`/`parseOpName`（整脚本 `mcp.js`）、`autoNameConversation`（`ui.js` 函数环境）、`isTlsHandshakeFailure`（`relay.mjs` 函数环境）。
- `check-agent`：`agentRootsText` 改为装载 `agent.js + core.js` 顶层函数 + `AGENT_ACCESS_LEVELS/DEFAULT`。
- `check-chat`：两处 `buildThinkingParams`、`mergeLeadingSystemMessages` 改 `core.js` 函数环境；`rejectedRequestParam` / `toToolCall` / `anthropicToolCalls` / `ChatProviders` 整脚本装 `chat-providers.js`；`caseAnthropicRequest` / `caseModelList` 两处大假环境改为 `core.js + init.js` 函数环境 + 假网络/DOM 桩。
- `check-stream`：legacy 模型断言改整脚本装 `chat-providers.js` 后走公开 `forFormat` 路径。
- 剩余 3 处：`check-ui` 的插件 IIFE 用例（本地未安装 live2d / live2d-models 时跳过）。
- 另修：`check-ui` 的 `live2d-models` 用例按 `manifest.id` 解析目录（不写死无版本号目录名），插件没有 `models/` 时按缺夹具跳过。
- 顺带修：模板串里的嵌套模板 / `${}` 会让旧抽取提前截断（`ui.js` 的 `renderFolderList` 抽不出来），已支持并加自测。
- 验证：全量 **PASS 2902 / FAIL 0**（check-frontend 40、check-stream 222、check-chat 280、check-browser 238、check-agent 408、check-mod 385）。



