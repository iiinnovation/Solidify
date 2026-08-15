---
name: solution-design
version: 2.1.0
displayName: 方案设计
description: 基于需求生成技术方案、架构说明和实施计划。已有需求规格或需要评估落地方案时使用。
icon: Lightbulb
placeholder: 描述项目需求，或粘贴需求分析文档...
allowed-tools: [read_file, list_dir, search_files, write_file]
skip-confirmation: true
---

# 方案设计

第一步读取 `reference/legacy-guidance.md` 和 `reference/mermaid-syntax.md`，再读取输入需求。输出技术选型、功能模块、数据模型、接口设计、实施计划和风险评估；架构图使用 Mermaid，并将文档与图分别落盘到 `03-交付物/`。

## 提交前自检

每个关键需求必须能追溯到组件、接口或实施任务；技术选型至少说明一个取舍，不堆砌技术名词。架构图只保留关键职责和依赖，避免超过 12 个节点、交叉连线、孤立节点和无内容分层。风险必须给出触发条件、影响和缓解措施。
