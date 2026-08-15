---
name: drawio-diagram
version: 2.1.0
displayName: Draw.io 流程图
description: 生成专业的 Draw.io 流程图或系统架构图。需要可视化流程、判断和系统关系时使用。
icon: Network
placeholder: 描述流程图的内容和场景...
allowed-tools: [read_file, write_file]
recommended-models: [DeepSeek, GPT-4]
skip-confirmation: true
---

# Draw.io 流程图

第一步读取 `reference/legacy-guidance.md`、`reference/layout-guidance.md` 和 `reference/xml-checklist.md`。先确定图类型、节点清单和分组，再按布局规范计算全部坐标，最后添加连线并输出合法 Draw.io XML。

## 提交前自检

简单架构图控制在 4-10 个核心节点，不为凑层级制造空容器。所有节点必须位于画布和所属容器内；连接线不得穿过节点、容器标题或标签；外部系统放入独立区域。发现重叠、越界、大片无意义留白或交叉线时，必须先调整坐标再交付。
