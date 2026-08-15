---
name: presentation
version: 2.1.0
displayName: 演示文稿
description: 生成结构化演示文稿。需要把方案、调研或项目进展整理成汇报幻灯片时使用。
icon: Presentation
placeholder: 描述演示文稿的主题、受众和核心内容...
allowed-tools: [read_file, list_dir, search_files, write_file]
recommended-models: [DeepSeek, GPT-4]
skip-confirmation: true
---

# 演示文稿

第一步读取 `reference/legacy-guidance.md` 和 `reference/legacy-format.md`。再读取输入材料，规划受众、核心结论和页面结构，生成旧版 slides JSON Artifact。每页只表达一个重点，控制标题和 bullet 长度，并将结果写入 `03-交付物/`。

## 提交前自检

整套叙事必须形成“背景-判断-证据-行动”闭环，每页只有一个可复述结论。标题表达结论而非栏目名；每页不超过 6 条要点，数据注明口径或标记待补。检查 JSON 可解析、布局字段匹配且没有连续重复版式。
