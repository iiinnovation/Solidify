---
name: presentation
version: 2.1.0
displayName: 演示文稿
description: 生成结构化演示文稿。需要把方案、调研或项目进展整理成汇报幻灯片时使用。
icon: Presentation
placeholder: 描述演示文稿的主题、受众和核心内容...
allowed-tools: [read_file, list_dir, search_files, generate_pptd, capture_preview]
recommended-models: [DeepSeek, GPT-4]
skip-confirmation: true
---

# 演示文稿

读取输入材料，整理受众、核心结论、事实依据和设计约束，然后调用一次 `generate_pptd`。该工具负责大纲、逐页生成、校验、定向修复和最终的单一 slides Artifact。不要读取 `reference/legacy-format.md`，不要手写旧版 slides JSON，也不要用 `write_file` 代替最终交付。

## 提交前自检

整套叙事必须形成“背景-判断-证据-行动”闭环，每页只有一个可复述结论。标题表达结论而非栏目名；每页不超过 6 条要点，数据注明口径或标记待补。最终回复只保留 `generate_pptd` 生成的一个 `type="slides"` Artifact。
