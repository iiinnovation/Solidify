# M5 · PPTD 演示文稿引擎

| | |
|---|---|
| **层** | 应用层 |
| **工期** | 5–7 周（约 25–33 pd） |
| **前置** | M4（Skill 体系）、M1 的 `capture_preview` |
| **并行** | 可与 M6 并行 |
| **规格** | [specs/pptd-subset.md](../specs/pptd-subset.md) |
| **相关决策** | [ADR-0003](../04-decisions.md#adr-0003) |
| **特性开关** | `pptdEngine` |

## 目标

把演示文稿能力从「8 种布局的模板填空」升级为「真正的排版引擎」，产出可直接给客户的 PPT。

## Demo（验收标准）

> 交办：「基于 `03-交付物/需求规格.md`，做一版给客户领导汇报的方案 PPT，深色商务风格，12 页左右。」
>
> AI 读取 Skill 规范 → 生成 PPTD 工程 → 渲染预览 → 截图自检 → 发现第 5 页文字重叠并自行修正 → 导出 pptx。
>
> **产出的 pptx 无需人工调版即可直接使用。**

## 分两段交付

M5 是最长的里程碑，拆成两段独立可验收：

| 段 | 内容 | 工期 | 交付价值 |
|---|---|---|---|
| **M5-A** | 解析 + 渲染 + 校验 + 视觉回环 | 3–4 周 | 预览可用，能看到高质量版式 |
| **M5-B** | pptx 导出 + 降级报告 + 旧格式迁移 | 2–3 周 | 可导出交付 |

M5-A 结束时即使导出还走旧链路，用户已经能获得明显更好的版式质量。这个中间态是有价值的，不要为了"一次做完"而放弃它。

## 任务清单

### 段 A：解析与渲染

#### A1. 类型与解析（4 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-01 | PPTD schema 的完整 TS 类型 | `src/lib/pptd/types.ts` | 1.5pd |
| M5-02 | YAML 解析（新增 `js-yaml` 依赖）+ 多文件组装 | `src/lib/pptd/parse.ts` | 1.5pd |
| M5-03 | `$变量` 解析：theme.colors / theme.textStyles 展开 | 同上 | 1pd |

#### A2. 渲染器（8 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-04 | 画布与 scale 适配框架 | `src/lib/pptd/renderer.tsx` | 1pd |
| M5-05 | `text` 元素（含富文本 HTML 子集、渐变、阴影） | `renderer/text.tsx` | 2pd |
| M5-06 | `shape` 元素（内置形状 + 纯色/渐变填充） | `renderer/shape.tsx` | 2pd |
| M5-07 | `image` 元素（fit: cover/contain + crop） | `renderer/image.tsx` | 1pd |
| M5-08 | `line` + `icon` 元素 | `renderer/line.tsx`、`icon.tsx` | 1pd |
| M5-09 | `table` 元素（cell 级样式） | `renderer/table.tsx` | 1pd |

M5-05 用 `DOMParser` 解析富文本，**不要用正则**。

#### A3. 校验器（3 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-10 | 结构校验：变量未定义、media 缺失、字段类型 | `src/lib/pptd/validate.ts` | 1pd |
| M5-11 | 版式校验：越界、重叠、字号、对比度、文本溢出估算 | 同上 | 2pd |

M5-11 是产出质量的第一道闸。8 项检查见 [pptd-subset.md §6](../specs/pptd-subset.md)。校验错误直接回灌模型自纠，比人工调版便宜得多。

#### A4. 视觉自检回环（4 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-12 | `capture_preview` 对接 PPTD 渲染器（逐页截图） | `src/lib/tools/builtin/capture-preview.ts` | 1.5pd |
| M5-13 | 自检 prompt 与回环控制（最多 N 轮，避免死循环） | Skill 内 + `src/lib/pptd/review.ts` | 1.5pd |
| M5-14 | 无 vision 能力模型的降级路径（只跑到 validate） | 同上 | 1pd |

#### A5. PPTD Skill（3 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-15 | 编写 `skills/pptd-deck/SKILL.md`（工作流） | Skill 目录 | 1pd |
| M5-16 | 整理 `reference/pptd.md`（格式规范，按支持范围裁剪） | 同上 | 1pd |
| M5-17 | `reference/design-guide.md` + `examples/` 少样本 | 同上 | 1pd |

⚠️ M5-16 要**按我们实际支持的范围裁剪规范**。把不支持的动画、自定义几何路径留在文档里，模型会生成它们，然后在导出时全部降级 —— 白白浪费 token 和一轮修正。

### 段 B：导出

#### B1. pptxgenjs 导出（8 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-18 | 导出框架 + 坐标单位换算（pt → inch，`/96`） | `src/lib/pptd/to-pptx.ts` | 1pd |
| M5-19 | `text` 导出（富文本 → textProps 数组） | `to-pptx/text.ts` | 2pd |
| M5-20 | `shape` 导出（内置形状映射表） | `to-pptx/shape.ts` | 1.5pd |
| M5-21 | `image` 导出（含预裁剪） | `to-pptx/image.ts` | 1pd |
| M5-22 | `line` + `icon` + `table` 导出 | `to-pptx/*.ts` | 1.5pd |
| M5-23 | 逐页比对测试：预览截图 vs 导出结果，偏差 < 2pt | 测试 | 1pd |

#### B2. 图表（5 pd）

| # | 任务 | 估时 |
|---|---|---|
| M5-24 | pptxgenjs 原生支持的 8 种图表（bar/line/area/pie/doughnut/scatter/bubble/radar） | 3pd |
| M5-25 | 其余 6 种（waterfall/heatmap/treemap/sunburst/sankey/candlestick）渲染为图片嵌入 | 2pd |

M5-25 的做法：用渲染器画出来 → `capture_preview` 截图 → 作为图片元素嵌入。复用已有能力，不引新图表库。

#### B3. 降级与迁移（4 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M5-26 | 降级记录与报告生成 | `src/lib/pptd/report.ts` | 1.5pd |
| M5-27 | 旧 8 布局 → PPTD 单向转换器 | `src/lib/pptd/migrate-legacy.ts` | 1.5pd |
| M5-28 | artifact 面板接入 PPTD 渲染器 | `src/components/artifacts/pptd-renderer.tsx` | 1pd |

M5-26 不能省。静默降级会让用户在客户面前才发现问题。

## 明确不做

| | 原因 |
|---|---|
| 动画 | pptxgenjs 不支持，需手写 OOXML，成本极高。预览可 CSS 模拟，导出丢弃 |
| 自定义几何路径 shape | pptxgenjs 的 custGeom 支持有限，降级为矩形 |
| 字体嵌入 | 需操作 OOXML 内部结构 |
| 页面切换效果 | 同上 |

## 风险

| 风险 | 概率 | 应对 |
|---|---|---|
| 渲染保真度不达预期 | 中 | 分段交付，A 段先把预览做到位再攻导出；用参考实现的示例工程做基准 |
| 模型生成的坐标质量差，回环收敛不了 | 中 | 校验器尽量严格；SKILL.md 里提供栅格化的布局建议（如 48pt 边距、12 列栅格）降低自由度 |
| 视觉回环成本高（每轮都要多模态调用） | 中 | 只对校验通过后的页面截图；限制回环轮次；只截有改动的页 |
| 富文本映射细节多导致超期 | 高 | 支持标签列表严格限定在 8 个，其余剥离为纯文本 |
| pptxgenjs 某些特性有 bug | 中 | 遇到即降级并记入报告，不与库死磕 |

## 完成定义

**段 A**：
- [x] 能解析并渲染参考实现的完整示例工程
- [x] 校验器 8 项检查全部实现
- [x] 视觉回环能自主发现并修正一处重叠

**段 B**：
- [x] [pptd-subset.md §10](../specs/pptd-subset.md) 的 9 个用例全部通过
- [x] 预览与导出逐页偏差 < 2pt
- [x] 降级报告完整
- [x] 旧 8 布局 artifact 可正常渲染与导出
- [x] **Demo 场景产出的 pptx 无需人工调版即可使用**

### 验收记录（2026-08-16）

- 完整测试：155 个测试文件、337 个测试，336 通过、1 个条件性跳过、0 失败。
- 参考工程：启用 `M5_EXPORT_REFERENCE=true` 后，成功解析、校验、渲染并导出 `Solidify-refs/open-kimi-ppt` 的 18 页示例。
- 几何保真：DOM 预览与导出 OOXML 的元素边界偏差均小于 2pt。
- 视觉回环：集成测试覆盖“发现重叠 → 修复 → 重新截图 → 审核通过”。
- 真实产物：已通过浏览器预览和 macOS Quick Look 检查导出的 PPTX，确认画布缩放、背景图、富文本换行及标题自适应正常。

## 后续清理

M5 稳定一个版本后删除：`src/lib/slide-types.ts`、`src/lib/slide-export.ts`、`src/lib/slide-themes.ts`、`src/components/artifacts/slides-renderer.tsx`。删除前确认 `migrate-legacy.ts` 覆盖了全部 8 种布局。
