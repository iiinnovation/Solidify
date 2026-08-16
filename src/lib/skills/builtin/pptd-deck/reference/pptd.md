# PPTD v2 本地子集

manifest 使用 YAML：

```yaml
version: v2
title: 示例
size: [960, 540]
theme:
  colors: { bg: '#ffffff', text: '#111827', accent: '#2563eb' }
  textStyles: { title: { fontSize: 32, bold: true, color: '$text' } }
pages: [pages/01.page]
```

页面文件包含 `pageType`、可选 `background` 和 `elements`。每个元素都有 `elementId`、`elementType` 和 `[x,y,width,height]` bounds。支持 text、shape、image、line、icon、table、chart；所有资源路径必须是工程内相对路径。

chart 元素使用 `chartType`、`data`、`xKey`、`yKey`，可选 `series`：

```yaml
- elementId: revenue
  elementType: chart
  bounds: [80, 130, 800, 320]
  chartType: bar
  xKey: quarter
  yKey: value
  data:
    - { quarter: Q1, value: 120 }
    - { quarter: Q2, value: 180 }
```

- bar、line、area、pie、doughnut、scatter、bubble、radar 导出为可编辑的 PowerPoint 原生图表。
- waterfall、heatmap、treemap、sunburst、sankey、candlestick 在预览中正常渲染，导出为静态图片并写入降级报告。
- 不生成动画、自定义几何路径、字体嵌入或页面切换效果。

Artifact 面板接受规范的多文件 JSON bundle：`{"manifest":"...","pages":{"pages/01.page":"..."},"media":{}}`。也接受 pages 直接内联为对象数组的 YAML，保存到工作区时仍应拆分为标准 `deck.pptd + pages/*.page + media/` 结构。
