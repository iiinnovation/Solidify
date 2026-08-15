---
name: gap-analysis
version: 2.1.0
displayName: 差距分析
description: 对比标准产品能力与客户需求，输出差距矩阵和定制建议。需要评估适配度或实施缺口时使用。
icon: GitCompareArrows
placeholder: 描述标准产品能力和客户需求...
allowed-tools: [read_file, list_dir, search_files, write_file]
skip-confirmation: true
---

# 差距分析

第一步读取 `reference/legacy-guidance.md` 的完整矩阵与输出规范。分别整理客户要求与现有能力，建立逐项差距矩阵，标注满足、部分满足或不满足，统计匹配度，并给出配置、定制和开发建议。信息不足时明确标注推断。

## 提交前自检

客户要求必须逐项映射，状态判断要引用现有能力证据，不把未知当作不满足。每个差距给出建议路径、影响、工作量级别和前置依赖；汇总数量与矩阵逐行结果必须一致。配置、定制和开发三类建议不得混用。
