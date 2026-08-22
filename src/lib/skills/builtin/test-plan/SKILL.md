---
name: test-plan
version: 2.1.0
displayName: 测试方案
description: 生成 UAT 测试用例和验收标准。需要把需求转成可执行测试方案时使用。
icon: TestTubeDiagonal
placeholder: 描述要测试的功能模块，或粘贴需求文档...
allowed-tools: [read_file, list_dir, search_files, write_file]
skip-confirmation: true
---

# 测试方案

覆盖测试范围、正常与异常流程、前置条件、操作步骤、预期结果、优先级、验收标准、测试数据和缺陷分级。只有用户明确给出公司测试模板或特殊缺陷分级规范时，才遵循该约束。每个核心功能至少给出一条正常和一条异常用例。

## 提交前自检

每个用例必须可独立执行并追溯到需求编号，明确前置条件、测试数据、步骤和可观察结果。核心功能至少覆盖正常、边界、异常和权限场景；不要用“功能正常”作为预期结果。优先级、缺陷等级和准入退出标准必须一致。
