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

1. 若已选择工作区，读取用户指定的工作区文件和必要素材，整理成自包含的 brief 与 materials；若未选择工作区，用户附件内容已经在当前对话中，直接整理进 brief 与 materials，不要按附件文件名调用 `read_file` 或 `read_handle`。不要自行生成页面 YAML。工作区内需要使用的 PNG/JPEG/GIF/WebP/SVG 图片路径通过 `mediaPaths` 传给工具；用户随消息上传的图片会自动进入媒体目录。
2. 根据任务判断演示场景。场景方法位于 `reference/slide-categories/`，可选设计系统位于 `reference/design-system/`；用户点名设计系统时把相对标识（例如 `consulting/apricot-white-brief`）传给 `designSystemId`。
3. 调用一次 `generate_pptd`。该工具内置 Art Director、大纲、逐页生成、装配校验、定向修复和最终单一 `slides` artifact。不要把远程图片 URL 写入 brief 或页面，图片只引用工具提供的本地 `media/...` 路径。
4. 工具成功后不要复述、拆分或重新包装 deck；其 artifact 会直接进入聊天交付流。
5. 工具内置的渲染校验与定向修复是本轮视觉复核依据；不得在 artifact 进入聊天交付流前调用截图工具，也不得用逐页 document 替代 deck。
6. 若复杂页面在有界修复后仍未通过，工具会用大纲中的结论和要点生成结构合法的安全版式，继续交付完整 deck，并在 artifact 顶部与逐页报告中显式标出降级页和原因。网络、鉴权、取消、工作区写入失败等技术故障仍会中止运行。
7. 已选择桌面工作区时，工具会把可恢复检查点写入 `.solidify/pptd-checkpoints/`；重试相同输入时复用已经完成的设计、大纲和页面。检查点是工作过程，不替代最终单一 `slides` artifact。

## 视觉质量底线

- 架构、流程、组件映射和依赖关系使用带标签的节点、连线、边界和方向表达；不要把非数值关系伪装成 chart。
- chart 只用于至少两条真实数值数据的趋势、比较或分布；不能接受只有坐标轴、空系列或全为 0 的图表。
- 深色背景上的正文、浅色背景上的正文都必须保持可读对比度；低对比度页面会被工具阻止交付并定向修复。
- 先保证一个清晰结论和一个完整证据对象，再添加装饰；不要用大面积空白、无标签线条或孤立组件填充页面。

## 提交前自检

- 最终回复中只有一个 `type="slides"` artifact，且内容包含所有页。
- 所有 `elementId` 唯一，bounds 位于 960×540 画布内。
- 文本使用主题样式或明确的字号/颜色，避免低对比度和文本互相覆盖。
- 图片只引用工程内 `media/` 文件；没有远程 URL 依赖。
- 每一页都能在右侧 Artifacts 中切换预览；未通过模型质量检查的页面必须使用结构合法的安全版式，并在 artifact 顶部显式列出。
- 导出结果逐页的几何坐标与 PPTD 保持一致；任何 icon/chart/gradient 降级都写入报告。
