---
name: pptd-deck
version: 1.0.0
description: 使用本地 PPTD v2 引擎生成、校验、预览和导出演示文稿
displayName: PPTD 演示文稿
allowed-tools: [read_file, list_dir, search_files, write_file, capture_preview]
skip_confirmation: true
---

# PPTD 演示文稿

将需求转成可审阅的 PPTD v2 工程：一个 `deck.pptd` YAML manifest、`pages/*.page` 页面文件和 `media/` 素材。始终使用本地 Solidify PPTD parser、renderer、validator 与 exporter，不调用浏览器侧 Kimi 编辑器或远程编辑服务。

## 工作流

1. 先阅读 `reference/pptd.md` 和 `reference/design-guide.md`，确定页面尺寸、主题 token 和元素边界。
2. 生成页面后运行结构校验：页面引用、元素 ID、边界、媒体和文本可读性必须通过。
3. 使用 `capture_preview` 按页截图；若模型支持视觉，逐页检查留白、重叠、溢出和层级，并修复后重新校验。
4. 最终使用本地 PPTX 导出器输出 `.pptx`，保留降级记录，不得静默丢失不支持的元素。

## 提交前自检

- 所有 `elementId` 唯一，bounds 位于 960×540 画布内。
- 文本使用主题样式或明确的字号/颜色，避免低对比度和文本互相覆盖。
- 图片只引用工程内 `media/` 文件；没有远程 URL 依赖。
- 每一页都能被 `capture_preview` 选择并复核。
- 导出结果逐页的几何坐标与 PPTD 保持一致；任何 icon/chart/gradient 降级都写入报告。
