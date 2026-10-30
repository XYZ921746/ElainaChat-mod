# 场景背景图

31 张场景背景图（7.25 MB），供**「Galgame 界面」**与**「Live2D 视频通话」**共用。

**公共资源插件**：不提供界面，被上面两个依赖。

## 里面有什么

```text
scene-backgrounds/
└─ img/bg/    31 张 .jpg（游乐园 / 咖啡厅 / 卧室 / 雪夜街道 / 天鹅湖 …）
```

## 为什么从 galgame 里分出来

这批图原先住在 `galgame/img/bg/`，但用它的**不只是** galgame —— 视频通话也要拿它们当背景。
留在 galgame 里会变成两个问题：

1. 视频通话要 `host.require('galgame')` 才能拿背景 —— "想要背景就得先启用剧情界面"
2. **卸载 galgame 会把背景一起带走**

资源与消费者分开后：想要背景就装/启用这一个包，两个界面都能用；
不想要剧情界面就关掉 galgame，背景照样在。

## 对外接口

挂在 `window.ElainaSceneBackgrounds`，消费方也可以用 `host.require('scene-backgrounds')`：

| 方法 | 说明 |
| --- | --- |
| `list()` | `[{ file, label, url }]` 全部背景，顺序即界面顺序 |
| `url(file)` | 文件名 → 背景图 URL（未知文件名返回空串） |
| `label(file)` | 文件名 → 中文标签（认不出返回文件名本身） |
| `has(file)` | 这个文件名存不存在 |
| `pick(keyword)` | 按中文标签/文件名模糊挑一张（供 AI 的 `[背景:雪夜]` 用） |

`pick()` 的匹配顺序：精确文件名 → 精确中文标签 → 子串（标签含关键词或反过来）→ 文件名子串。
映射放在资源侧，两个消费方就不用各写一份匹配逻辑。

## 怎么加图

1. 把 `.jpg` 放进 `img/bg/`
2. 在 `index.js` 的 `BGS` 数组里补一行 `['文件名', '中文标签']`

> ⚠️ 漏了第 2 步不会报错 —— 只是那张图在列表里**选不到**（静默失效）。
> `scripts/check-scene-backgrounds.mjs` 会核对「目录里的文件」与「BGS 清单」是否一一对应。

## 资源基址

**不要**自己拼 `/mods/scene-backgrounds/img/bg/…` —— 插件声明的 `id` 与实际安装目录名
**可能不同**（历史版本装出过带版本号的目录）。用 `url(file)`，它按真实目录算。

## 已知限制

- 图片不入库（见 `.gitignore`），走 Releases 分发 —— 装"纯净版"APK 时需单独下载
- 只有 `.jpg`（`url()` 固定拼 `.jpg`）；要支持 png/webp 得改 `url()`
