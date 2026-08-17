---
name: pptd-deck
version: 1.0.0
description: 使用本地 PPTD v2 引擎生成、校验、预览和导出演示文稿
displayName: PPTD 演示文稿
allowed-tools: [read_file, list_dir, search_files, generate_pptd, capture_preview]
skip-confirmation: true
---

# PPTD 演示文稿

将需求转成可审阅的 PPTD v2 工程：一个 `deck.pptd` YAML manifest、`pages/*.page` 页面文件和 `media/` 素材。始终使用本地 Solidify PPTD parser、renderer、validator 与 exporter，不调用浏览器侧 Kimi 编辑器或远程编辑服务。

## 交付契约

- 整份 deck 只能交付为一个 `<solidify-artifact type="slides">`，不得把每页拆成独立 artifact，也不得使用 `type="document"` 交付页面 YAML。
- artifact 必须包含能独立渲染的完整 deck：优先输出 `{ manifest, pages, media }` bundle JSON，也可输出顶层含 `pages[]` 的内联 YAML。
- artifact 路径使用 `03-交付物/deck.pptd`。`write_file` 生成的 manifest 和分页文件是工作过程，不能代替上述单一 artifact 交付。

## 工作流

1. 先读取用户指定的工作区文件和必要素材，整理成自包含的 brief 与 materials；不要自行生成页面 YAML。
2. 调用一次 `generate_pptd`。该工具负责大纲、逐页生成、装配校验、定向修复和最终单一 `slides` artifact。
3. 工具成功后不要复述、拆分或重新包装 deck；其 artifact 会直接进入聊天交付流。
4. 后续视觉复核只针对已生成 artifact 使用 `capture_preview`，不得用逐页 document 替代 deck。

## 提交前自检

- 最终回复中只有一个 `type="slides"` artifact，且内容包含所有页。
- 所有 `elementId` 唯一，bounds 位于 960×540 画布内。
- 文本使用主题样式或明确的字号/颜色，避免低对比度和文本互相覆盖。
- 图片只引用工程内 `media/` 文件；没有远程 URL 依赖。
- 每一页都能被 `capture_preview` 选择并复核。
- 导出结果逐页的几何坐标与 PPTD 保持一致；任何 icon/chart/gradient 降级都写入报告。
