---
name: pptd-deck
version: 2.0.0
description: 使用 Solidify 的本地 PPTD 引擎和从 Solidify-refs 同步的专业设计知识生成、审阅与导出演示文稿；适用于 PPT、PPTX、slide deck、汇报、课件、答辩、方案、海报和信息图任务
displayName: PPTD 演示文稿
allowed-tools: [read_file, list_dir, search_files, generate_pptd]
skip-confirmation: true
---

# PPTD 演示文稿

使用 `generate_pptd` 创建一个可预览、可校验、可导出 PPTX 的完整
PPTD v2 演示文稿。`Solidify-refs/open-kimi-ppt` 是格式、场景、设计系统
和视觉质量的权威来源；本 Skill 内的 `reference/` 是其随应用发布的副本。

## Solidify 执行契约

1. 判断任务类型、受众、目的、输入类型、设计方向和页数。只有这些信息
   会实质改变结果且无法从用户材料推断时才追问。
2. 对用户上传的 Markdown、PDF、Word 或文本附件，不调用附件搜索或分段
   读取工具。把附件 manifest 中的 ID 原样传入 `attachmentIds`，由
   `generate_pptd` 在内部建立完整的来源索引。
3. 仅在用户明确指定工作区文件时使用 `read_file`、`list_dir` 或
   `search_files`。把必要内容压缩进 `brief`/`materials`；图片路径放进
   `mediaPaths`。不要把用户附件文件名当作工作区路径。
4. 普通生成任务只调用一次 `generate_pptd`。不要手写 `.page` YAML，
   不要手工拼装 artifact，不要在工具返回后重新包装、拆分或复制 deck。
5. 普通文档型 deck 显式传入 `maxPages: 12`；可按用户需求在 10–14 页内
   调整，只有用户明确要求长文稿时才超过 14 页。
6. 工具负责来源索引、艺术指导、大纲、逐页生成、结构校验、有限修复、
   安全版式、预览和最终 `slides` artifact。PPTX 由 Solidify 的导出 UI
   从同一 PPTD 工程生成。

## 参考资料路由

普通生成（包括架构图、流程图、海报和信息图）不调用 `read_file`
读取 bundled 参考；`generate_pptd` 会按任务自动渐进加载。只有用户
明确要求检查/编辑现有 PPTD、解释具体规范或调试 Skill 资源时，
才先读 `reference/index.md`，再读它指向的文件。下列路径都是相对
运行时提供的 `Skill resource root`；调用 `read_file` 时必须先与该根路径
拼接，不得把相对路径当作工作区文件。

- 场景选择：`reference/slide-categories.md` 和一个匹配的场景文件。
- 设计系统：`reference/design-system/<family>/<name>/design.md`；一次只用
  一个系统，不混搭。
- PPTD 格式或编辑兼容：同时读取完整的 `reference/pptd.md` 和当前实现边界
  `reference/solidify-pptd-support.md`，不要生成本地引擎尚未支持的字段。
- 字体、形状、海报：分别使用 `reference/fonts.md`、
  `reference/shapes.md`、`reference/general-poster.md`。
- 上游完整能力与 QA 方法：`reference/open-kimi-workflow.md`。其中的外部
  命令仅作能力参考，当前聊天运行仍以本节 Solidify 契约为准。

只使用上述明确列出的资源路径，不要发明或探测其他路径。

## 内容与视觉底线

- 一页只承担一个可复述结论；用证据、解释、来源和行动项支撑结论。
- 根据内容选择图表、表格、时间线、流程、架构、图片或文字，不把所有
  页面降级成项目符号、等分卡片或“大标题 + 大空白”。
- 架构、流程和依赖使用有标签节点与正交连线；只有真实数值序列才使用
  chart。不得虚构数据、来源、案例或图片。
- 设计系统决定配色、字体、密度、组件和页面节奏。正文页必须具有足够
  信息密度，同时保持安全边距、可读对比度和清晰阅读顺序。
- 用户图片优先；只有与本页结论直接相关时才使用图片，禁止拉伸和无关
  装饰。没有图片时使用结构化矢量表达，不生成空图片占位。
- 工具失败页必须进入有限修复或确定性安全版式，不能把“生成失败”占位
  页当成成品交付。

## 交付

最终聊天只交付工具生成的一个 `type="slides"` artifact。保持所有页面、
主题和本地媒体自包含；不要输出旧版 `{ "slides": [...] }` 格式，也不要
用多个 document artifact 代替完整 deck。
