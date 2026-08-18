---
name: pptd-deck
version: 1.2.0
description: 使用本地 PPTD v2 引擎与专业设计系统生成、校验、预览和导出演示文稿
displayName: PPTD 演示文稿
allowed-tools: [read_file, list_dir, search_files, generate_pptd]
skip-confirmation: true
---

# PPTD 演示文稿

将需求转成可审阅的 PPTD v2 工程：一个 `deck.pptd` YAML manifest、`pages/*.page` 页面文件和 `media/` 素材。始终使用本地 Solidify PPTD parser、renderer、validator 与 exporter，不调用浏览器侧 Kimi 编辑器或远程编辑服务。

## 交付契约

- 整份 deck 只能交付为一个 `<solidify-artifact type="slides">`，不得把每页拆成独立 artifact，也不得使用 `type="document"` 交付页面 YAML。
- artifact 必须包含能独立渲染的完整 deck：优先输出 `{ manifest, pages, media }` bundle JSON，也可输出顶层含 `pages[]` 的内联 YAML。
- artifact 路径使用 `03-交付物/deck.pptd`。`write_file` 生成的 manifest 和分页文件是工作过程，不能代替上述单一 artifact 交付。

## 工作流

1. 先读取用户指定的工作区文件和必要素材，整理成自包含的 brief 与 materials；不要自行生成页面 YAML。工作区内需要使用的 PNG/JPEG/GIF/WebP/SVG 图片路径通过 `mediaPaths` 传给工具；用户随消息上传的图片会自动进入媒体目录。
2. 根据任务判断演示场景。场景方法位于 `reference/slide-categories/`，可选设计系统位于 `reference/design-system/`；用户点名设计系统时把相对标识（例如 `consulting/apricot-white-brief`）传给 `designSystemId`。
3. 调用一次 `generate_pptd`。该工具内置 Art Director、大纲、逐页生成、装配校验、定向修复和最终单一 `slides` artifact。不要把远程图片 URL 写入 brief 或页面，图片只引用工具提供的本地 `media/...` 路径。
4. 工具成功后不要复述、拆分或重新包装 deck；其 artifact 会直接进入聊天交付流。
5. 工具内置的渲染校验与定向修复是本轮视觉复核依据；不得在 artifact 进入聊天交付流前调用截图工具，也不得用逐页 document 替代 deck。
6. 若复杂页面在有界修复后仍不可交付，工具会显式失败并保留最新预览；不得把失败页改写成纯文本页冒充完成品。

## 提交前自检

- 最终回复中只有一个 `type="slides"` artifact，且内容包含所有页。
- 所有 `elementId` 唯一，bounds 位于 960×540 画布内。
- 文本使用主题样式或明确的字号/颜色，避免低对比度和文本互相覆盖。
- 图片只引用工程内 `media/` 文件；没有远程 URL 依赖。
- 每一页都通过工具内置的渲染校验并能在右侧 Artifacts 中切换预览。
- 导出结果逐页的几何坐标与 PPTD 保持一致；任何 icon/chart/gradient 降级都写入报告。
