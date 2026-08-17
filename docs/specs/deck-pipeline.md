# spec · 演示文稿分层生成管线

> 约束模块：`src/lib/pptd/`、`src/lib/engine/`　状态：**已评审，管线主体已实现**
> 相关：[specs/pptd-subset.md](pptd-subset.md)、[specs/agent-loop.md](agent-loop.md)、[phases/M5-pptd-engine.md](../phases/M5-pptd-engine.md)

## 1. 问题

现状是**单层链路**：把基座提示 + 技能体 + 全量历史一次性交给模型，指望它一轮吐出整份 deck。实测暴露三个问题。

### 1.1 输出契约自相矛盾

一次真实运行里，system prompt 同时携带两份不兼容的契约：

| 来源 | 指令 |
|---|---|
| 基座（`engine/messages.ts`） | 交付物用 `<solidify-artifact … type="document" path="03-交付物/file.md">` 输出，示例硬编码 `type="document"` |
| 技能体（`skills/builtin/pptd-deck/SKILL.md`） | 生成 `deck.pptd` + `pages/*.page` 文件，走 `write_file` |

两边都没有声明"**整份 deck 必须是单个 `type="slides"` 的 artifact**"。而渲染入口 `pptd/artifact.ts` 的 `parsePptdArtifactContent()` 只接受单个 artifact 内的完整 deck，三选一：

1. bundle JSON：`{ manifest, pages, media }`
2. 内联 YAML：顶层含 `pages[]` 数组
3. legacy slides JSON（迁移边界）

模型于是折中——**每页各发一个 `type="document"` artifact**。观察到的现象：7 个同名"PPTD 页面清单"文档，每个 `.page` 的 YAML 被 MarkdownRenderer 当 markdown 渲染成 bullet 列表。

### 1.2 单轮上下文无界增长

实测一次 pptd-deck 首轮请求的构成：

| 部分 | 体积 |
|---|---|
| system 合计 | 2,510 字符 ≈ 784 tok（基座 257 + 技能 351 + 工具 173） |
| 原生 tools 数组 | ≈ 513 tok |
| 首轮 messages | ≈ 16 tok |

system **不是**膨胀源。膨胀来自循环本身：每一轮重发完整历史 + 全部工具结果 + 模型已产出的长文本。一次 31s 的运行累计 46,020 tokens，而工具调用只有 2 次。

> 工具清单曾在 system 里重复一份（`buildToolsSection`），与原生 `tools` 数组重叠约 173 tok，已移除。

### 1.3 整份成败绑定

deck 是一次生成的单一长文本，任何一页出错、或触顶输出上限，都会波及整份产物。续写机制（`engine/query.ts` 的 `MAX_CONTINUATIONS`）能救回截断，但救不回"第 7 页排版错了"——只能整份重来。

## 2. 目标链路

把"一次长生成"拆成**四个有界阶段**，模型只在需要判断力的地方出现，装配与校验交给确定性代码。

```
用户意图
   │
   ├─ ① 大纲       1 次小请求 · 结构化 JSON        ~500 tok out
   │
   ├─ ② 逐页生成   N 次小请求 · 可并行 · 互不可见   ~300 tok out each
   │
   ├─ ③ 装配校验   纯代码 · 无模型
   │
   └─ ④ 定向修复   仅失败页回炉 · 带校验错误
```

### 阶段 ① 大纲

**唯一**需要看到完整用户意图的阶段。输入：用户需求 + 检索到的素材。输出结构化大纲，不含任何坐标或样式。

```ts
interface DeckOutline {
  title: string
  audience: string          // 受众，影响措辞与详略
  goal: string              // 这份 deck 要让受众做出什么决定
  themeId: PptdThemeId      // 从受控预设选择，一次定死
  pages: Array<{
    pageType: string        // cover / agenda / content / chart / summary …
    intent: string          // 这一页要让受众记住的唯一结论
    keyPoints: string[]     // 3–6 条，纯文本，不含排版
    dataHint?: string       // 需要图表时说明数据口径
  }>
}
```

约束：`pages.length` 上限 24；`keyPoints` 每页 ≤ 6 条。超限在此处截断并告知用户，不带进下游。

### 阶段 ② 逐页生成

每页一次独立请求。**关键：不传历史、不传其他页、不传原始用户输入。**

输入仅三项：
- `theme`（由阶段 ① 的 `themeId` 解析出的受控色板与文字样式）
- 元素契约（`reference/pptd.md` 的元素子集 + 960×540 边界）
- 该页那**一条** `pages[i]` 大纲

输出：单个 `.page` YAML。

这样每次请求的输入稳定在 ~1.5k tok、输出 ~300 tok，**结构性地不可能触顶**，也不会因为看到别页而互相污染。

并发受现有约束：`sub-agent/types.ts` 中 `MAX_SUB_AGENTS_PER_DISPATCH = 5`、`MAX_SUB_AGENT_CONCURRENCY = 5`、`MAX_SUB_AGENT_DEPTH = 1`。12 页需分批，或为本管线走独立调度而非通用 `dispatchSubAgents()`（见 §5 未决）。

### 阶段 ③ 装配校验

**纯代码，零模型调用。** 复用既有能力：

- 合成 `PptdProject`（`pptd/types.ts`）：`{ version, title, size, theme, pages, pagePaths, media }`
- 调 `validatePptdProject()`（`pptd/validate.ts`）：已覆盖 elementId 唯一性、bounds 越界、文本重叠、未解析 token、非法颜色、图表规格
- 产出 `PptdValidationResult`，按 `pagePath` 归集诊断

### 阶段 ④ 定向修复

只把**校验失败的页**连同其诊断发回模型，输入依旧不含其他页。最多 2 轮；仍失败则保留该页并在报告中标注，不阻塞整份交付。

视觉自检（留白/重叠/层级）沿用既有 `runPptdReviewLoop()`（`pptd/review.ts`），作为可选的第五步，仅在模型支持视觉时启用。

## 3. 对接点

| 阶段 | 复用 | 需新增 |
|---|---|---|
| ① | `model/` Provider 流式接口 | 大纲 schema + 结构化输出约束 |
| ② | `engine/sub-agent/scheduler.ts`、`model/` Provider | 逐页提示模板；批量调度 |
| ③ | `pptd/validate.ts`、`pptd/types.ts` | 装配器（pages → PptdProject） |
| ④ | `pptd/review.ts` | 诊断→提示的映射 |
| 出口 | `pptd/artifact.ts` | 直接产出 bundle JSON，单个 `type="slides"` artifact |

## 4. 分期

1. **止血**（独立于本管线，可先做）：基座示例不再硬编码 `type="document"`；`pptd-deck/SKILL.md` 明确"整份 deck 输出为单个 `type="slides"` artifact"。仅此即可消除 §1.1 的 7 文档症状。
2. **③ 装配校验**：纯函数，最易测，先落地并补测试。
3. **① + ②**：管线主体。
4. **④ + 视觉复核**：收敛质量。

## 5. 已决问题（2026-08-17）

- **调度归属**：采用 PPTD 专用编排器 `generatePptdDeck()`，复用 `SubAgentScheduler` 的有界 FIFO 与 5 并发上限，不走 `dispatchSubAgents()` 的完整 Agent 循环。实际模型调用仍使用当前 `ModelProvider`，并通过 `createPptdModelCaller()` 计入 `SharedTaskTreeBudget`。
- **结构化输出**：阶段 ① 采用跨网关基线：严格 JSON 提示、标准 `JSON.parse`、运行时字段校验和一次纠错。暂不把 provider-native structured output 作为正确性前提，避免 OpenAI 兼容网关能力漂移；以后可作为同一接口下的优化路径。
- **主题来源**：模型只选择 `themeId`，代码从 `business-light`、`business-dark`、`editorial`、`data` 四个受控预设解析出 `PptdTheme`。显式用户选择优先，模型值无效时按 brief 确定性推断。
- **失败页占位**：阶段 ④ 对校验错误及文本溢出、低对比度、小字号、非法颜色、未解析 token、遮挡等可修复 warning 最多处理两轮；仍失败则由代码生成保留原始结论和要点的纯文本页，并在 `pageReports` 与 warnings 中记录降级，不阻塞整份交付。

实现位于 `src/lib/pptd/pipeline.ts`、`theme-presets.ts` 和 `artifact.ts`。最终结果直接包含单个 `type="slides"` 的 bundle artifact 描述，上层入口无需再让模型复述整份 deck。
