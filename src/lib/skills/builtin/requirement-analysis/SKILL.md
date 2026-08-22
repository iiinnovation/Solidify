---
name: requirement-analysis
version: 2.1.0
displayName: 需求分析
description: 结构化梳理客户需求，输出需求规格文档。用户提供访谈纪要、调研材料或原始需求时使用。
icon: ClipboardList
placeholder: 描述客户需求或粘贴需求相关材料...
allowed-tools: [read_file, list_dir, search_files, write_file]
skip-confirmation: true
---

# 需求分析

先读取用户提供的全部材料，提取背景、目标、功能与非功能需求，标注假设和待确认事项，生成结构化 Markdown 交付物。只有用户要求严格编号或特殊输出格式时，才按需读取 `reference/output-format.md`。存在工作区时写入 `03-交付物/`，否则通过内存 Artifact 交付。

## 提交前自检

每条需求使用稳定编号，并包含角色、触发条件、预期行为、优先级和可验证验收标准。事实、假设、约束和待确认项必须分开；不得补造用户未提供的业务规则。检查需求之间是否冲突，并确保关键原始材料都有对应条目。
