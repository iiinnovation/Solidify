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
