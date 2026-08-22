---
name: drawio-diagram
version: 2.1.0
displayName: Draw.io 流程图
description: 生成专业的 Draw.io 流程图或系统架构图。需要可视化流程、判断和系统关系时使用。
icon: Network
placeholder: 描述流程图的内容和场景...
allowed-tools: []
recommended-models: [DeepSeek, GPT-4]
skip-confirmation: true
---

# Draw.io 流程图

先确定图类型、节点清单和分组，再按布局规范计算全部坐标，最后添加连线并输出合法 Draw.io XML。普通生成任务（尤其是根据附件生成架构图）直接依据本 Skill 的约束完成，不要调用 `read_file` 读取 `reference/layout-guidance.md` 或 `reference/xml-checklist.md`；只有用户明确要求严格校验且确实需要额外细则时才读取参考资料。系统架构图必须把每个组件或职责生成为独立的有填充色方块；禁止用一个无边框 text 节点加项目符号代替整层组件。

最终结果必须且只能使用一个 Draw.io Artifact 交付，不要把 XML 直接输出到对话正文，也不要使用 Markdown 代码围栏：

```text
<solidify-artifact type="drawio" title="图表标题" path="03-交付物/图表标题.drawio">
<mxfile>...</mxfile>
</solidify-artifact>
```

## 提交前自检

简单架构图控制在 4-10 个核心节点，不为凑层级制造空容器。每个业务节点必须包含 `rounded=1`、非 `none` 的 `fillColor` 和 `strokeColor`；容器保持浅色，节点使用 `reference/layout-guidance.md` 的分层配色。所有节点必须位于画布和所属容器内；连接线不得穿过节点、容器标题或标签；外部系统放入独立区域。发现文本列表替代节点、重叠、越界、大片无意义留白或交叉线时，必须先调整 XML 再交付。
