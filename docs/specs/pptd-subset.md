# spec · PPTD 支持范围

> 约束模块：`src/lib/pptd/`　对应里程碑：[M5](../phases/M5-pptd-engine.md)
> 相关决策：[ADR-0003](../04-decisions.md#adr-0003)

## 1. 为什么换掉现有的幻灯片模型

现有模型（`src/lib/slide-types.ts`）是 8 种固定布局的**模板填空**：

```ts
type SlideLayout = 'title' | 'content' | 'two-column' | 'image-text'
                 | 'comparison' | 'stats' | 'timeline' | 'section'
```

模型只能往固定槽位塞文本，无法控制任何元素的位置、大小、层级、填充。表达力天花板决定了产出永远是"一眼 AI 生成"的观感。

PPTD 是 **960×540pt 绝对坐标系 + 元素模型**，是真正的排版。这是从"填模板"到"做设计"的差别。

## 2. 格式结构

```
方案汇报.pptd/
├── deck.pptd            清单：版本、标题、画布尺寸、主题、页面列表
├── pages/
│   ├── 01_cover.page    单页：pageType + background + elements[]
│   └── 02_agenda.page
└── media/
    └── hero.jpg
```

`deck.pptd`：

```yaml
version: v2
title: 客户A数字化方案汇报
size: [960, 540]
theme:
  colors:
    bg: "#0C0C0E"
    text: "#F2F0EA"
    accent: "#D9A441"
  textStyles:
    pageTitle: { fontSize: 36, color: "$text", lineHeight: 1.35 }
    body:      { fontSize: 13, color: "$muted", lineHeight: 1.75 }
pages:
  - pages/01_cover.page
  - pages/02_agenda.page
```

`*.page`：

```yaml
pageType: cover
background: { type: solid, color: "$bg" }
elements:
  - elementId: title
    elementType: text
    bounds: [48, 282, 780, 200]      # [x, y, w, h]，单位 pt
    content:
      fontSize: 76
      color: "$text"
      align: [left, top]
      text: |
        <p><strong>一寸万象</strong></p>
```

三个要点：

- **每页自包含**，没有母版继承，所见即所得
- `$xxx` 引用 theme 中的变量，解析在加载期完成
- 富文本用 HTML 子集（`<p>` `<strong>` `<em>` 等）

## 3. 支持范围矩阵

| 元素 / 特性 | 预览渲染 | PPTX 导出 | 阶段 |
|---|---|---|---|
| **text** 基础（字号/色/对齐/行高/字距） | ✅ | ✅ | MVP |
| **text** 富文本（p/strong/em/span 内联样式） | ✅ | ✅ 转 textProps 数组 | MVP |
| **text** 渐变填充 | ✅ | ⚠️ 降级为纯色 | MVP |
| **text** 阴影 | ✅ | ✅ | 完整版 |
| **shape** 内置形状（rect/ellipse/triangle/arrow…） | ✅ | ✅ | MVP |
| **shape** 纯色/渐变填充 | ✅ | ✅ | MVP |
| **shape** 图片填充 | ✅ | ⚠️ 降级为图片元素 | 完整版 |
| **shape** 自定义几何路径 | ⚠️ 降级为矩形 | ⚠️ 降级为矩形 | 不做 |
| **image** 基础 + fit（cover/contain） | ✅ | ✅ | MVP |
| **image** crop / 自定义裁剪轮廓 | ✅ | ⚠️ 预裁后嵌入 | 完整版 |
| **line** 直线 | ✅ | ✅ | MVP |
| **line** 贝塞尔曲线 | ✅ | ⚠️ 降级为折线 | 完整版 |
| **icon**（Font Awesome） | ✅ | ✅ 转矢量或图片 | MVP |
| **table** 基础 + cell 级样式 | ✅ | ✅ | MVP |
| **chart** bar/line/area/pie/doughnut/scatter/bubble/radar | ✅ | ✅ pptxgenjs 原生 | 完整版 |
| **chart** waterfall/heatmap/treemap/sunburst/sankey/candlestick | ✅ | ⚠️ 渲染为图片嵌入 | 完整版 |
| **animations**（6 类效果 + 触发器 + 路径） | ⚠️ CSS 模拟 | ❌ **丢弃** | 不做 |
| **customFonts** 字体嵌入 | ✅ | ❌ 不做 | 不做 |
| 页面切换效果 | — | ❌ 不做 | 不做 |

图例：✅ 支持　⚠️ 降级支持　❌ 不支持

### 降级必须可见

任何降级都要在导出后给用户一份报告：

```
导出完成，有 3 处降级：
  · 第 2 页 "title" 的文字渐变已转为纯色 #D9A441
  · 第 5 页的桑基图已转为静态图片，PPT 中不可编辑
  · 全部动画效果已丢弃（PPTX 导出不支持）
```

静默降级会让用户在客户面前才发现问题。

## 4. 坐标与单位换算

PPTD 用 pt，画布 960×540。pptxgenjs 的 `LAYOUT_16x9` 是 10 × 5.625 inch。

```ts
const PT_TO_INCH = 10 / 960      // = 1/96

const toInch = (pt: number) => pt / 96
```

预览渲染用 CSS `transform: scale()`：

```tsx
<div style={{
  width: 960, height: 540, position: 'relative',
  transform: `scale(${containerWidth / 960})`,
  transformOrigin: 'top left',
}}>
  {elements.map(el => (
    <div style={{
      position: 'absolute',
      left: el.bounds[0], top: el.bounds[1],
      width: el.bounds[2], height: el.bounds[3],
    }} />
  ))}
</div>
```

用 scale 而不是按比例重算每个元素的尺寸 —— 前者保证预览与导出严格同构，后者会引入舍入误差。

## 5. 模块划分

```
src/lib/pptd/
├── types.ts          PPTD schema 的 TS 类型
├── parse.ts          YAML → 对象；$变量解析；结构校验
├── validate.ts       语义校验：越界、重叠、字号过小、对比度
├── renderer.tsx      → React 绝对定位渲染
├── to-pptx.ts        → pptxgenjs
└── report.ts         降级报告生成
```

新增依赖：`js-yaml`。

## 6. 语义校验（validate.ts）

这一层是产出质量的关键。绝对定位格式下，模型算错坐标必然发生，靠校验器提前发现比靠模型自觉可靠得多。

| 检查 | 级别 | 说明 |
|---|---|---|
| 元素超出画布边界 | error | `x + w > 960` 或 `y + h > 540` |
| 文本元素相互重叠 | error | 两个 text 的 bounds 相交面积 > 阈值 |
| 元素完全在另一元素之下且不可见 | warn | 可能是层级写错 |
| 正文字号 < 10pt | warn | 投影不可读 |
| 文字与背景对比度 < 4.5:1 | warn | WCAG AA |
| 文本内容长度超出 bounds 估算容量 | warn | 会溢出或被裁 |
| `media/` 中引用的文件不存在 | error | |
| `$变量` 未在 theme 中定义 | error | |

校验结果直接回灌给模型，让它自己修 —— 这比人工调版便宜得多。

## 7. 视觉自检回环

校验器只能发现规则性问题，发现不了"丑"。配套的视觉回环：

```
生成 PPTD
    ↓
parse + validate  ──有 error──→ 回灌错误，模型修正 ──┐
    ↓ 通过                                        │
renderer 渲染                                      │
    ↓                                             │
capture_preview 工具截图（M1 已提供）                 │
    ↓                                             │
多模态模型审阅："这一页有什么排版问题？"                  │
    ↓ 有问题 ───────────────────────────────────────┘
    ↓ 无问题
to-pptx 导出
```

⚠️ 这个回环需要模型支持 vision（见 [agent-loop.md §5](agent-loop.md) 的 `ModelCapabilities.vision`）。不支持 vision 的模型只能跑到 validate 这一步。

**这是 M5 必须排在 M1 之后的硬原因** —— 没有工具调用循环和 `capture_preview`，这个回环无法实现，PPT 的产出质量就无法保证。

## 8. 富文本映射

PPTD 的 HTML 子集 → pptxgenjs 的 textProps 数组：

```yaml
text: |
  <p>常规文字 <strong>加粗</strong> 和 <em>斜体</em></p>
```

```ts
slide.addText([
  { text: '常规文字 ', options: {} },
  { text: '加粗',      options: { bold: true } },
  { text: ' 和 ',      options: {} },
  { text: '斜体',      options: { italic: true } },
], { x, y, w, h, fontSize, color, align, valign })
```

支持的标签：`<p>` `<br>` `<strong>` `<b>` `<em>` `<i>` `<u>` `<s>` `<span style="...">`。

其他标签一律剥离为纯文本，并在降级报告中列出。**不要用正则解析 HTML**，用 `DOMParser`（浏览器环境可用）。

## 9. 从旧格式迁移

现有的 8 布局 `SlideItem` 数据需要能继续打开。做一个单向转换器：

```ts
// src/lib/pptd/migrate-legacy.ts
export function legacyToPptd(deck: SlidesDeck): PptdProject
```

每种 legacy 布局映射到一组固定的 PPTD 元素（就是把现在 `slide-export.ts` 里的 `switch (layout)` 逻辑翻译成 PPTD 元素）。转换后旧 artifact 可正常渲染与导出，之后统一走新链路。

`slides-renderer.tsx` 和 `slide-export.ts` 在迁移完成并稳定一个版本后删除。

## 10. 验收测试

| 用例 | 期望 |
|---|---|
| 解析参考实现的完整示例工程 | 无报错，所有页面渲染 |
| 预览截图与导出的 pptx 逐页比对 | 元素位置偏差 < 2pt |
| 元素超出画布 | validate 报 error，模型收到并修正 |
| 两段文字重叠 | validate 报 error |
| 含 sankey 图的 deck | 导出成功，该图为图片，降级报告中列出 |
| 含动画的 deck | 导出成功，动画丢弃并在报告中说明 |
| 旧 8 布局 artifact | 通过 migrate 正常渲染与导出 |
| 缺失 media 文件 | validate 报 error，不产出破图 |
| 一次完整生成（含视觉回环） | 产出的 pptx 无需人工调版即可使用 |
