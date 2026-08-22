# PPTD 性能优化指南

## 当前性能瓶颈

### 1. 首字延迟（TTFT - Time To First Token）

**现状**：每页生成首字延迟 2-5 秒

**原因**：
- Prompt 长度：1500-3500 input tokens
- 模型需要处理完所有 input tokens 才能开始生成
- 没有使用 Prompt Caching

**影响**：
- 用户感知延迟明显
- 10 页 PPT 的首字延迟累计 20-50 秒

### 2. 总体完成时间

**现状**：
- 小 deck（3-6 页）：约 60-120 秒
- 大 deck（10-15 页）：约 180-360 秒

**原因**：
- 并发度从 5 降到 3（稳定性 vs 速度的 trade-off）
- Design + Outline 阶段串行（约 10-15 秒）
- 每页生成时间：15-40 秒

---

## 已实施的优化

### ✅ 智能动态并发度（2026-08-20）

**实现**：
```typescript
// pipeline.ts:256-268
const defaultConcurrency = (input.maxPages ?? DEFAULT_MAX_PAGES) <= SMALL_DECK_MAX_PAGES
  ? MAX_PIPELINE_CONCURRENCY            // 3
  : LARGE_DECK_PIPELINE_CONCURRENCY     // 2
```

**效果**：
- 小 deck（≤6 页）：保持 3 并发，速度不变
- 大 deck（>6 页）：降到 2 并发，减少网关限流风险

**Trade-off**：
- 优点：大 deck 更稳定，减少 "Load failed" 错误
- 缺点：大 deck 总时间增加约 30-50%

---

## 推荐的优化方案（实现说明，非收益承诺）

> 旧版本中的伪代码只描述供应商能力，不代表当前请求格式。实际实现位于
> `src/lib/model/types.ts`、`src/lib/model/anthropic.ts` 和 `src/lib/model/openai.ts`；
> 具体命中率和延迟必须用真实 provider 基准验证。

### 优先级 1：实现 Anthropic Prompt Caching

**历史估计（未作为门禁）**：
- 首字延迟、输入成本和总体时间的改善幅度均需由真实 provider 结果确认，不得直接引用本节旧估计。

**实现步骤**：

#### 1.1 扩展类型定义

```typescript
// src/lib/model/types.ts

export interface UnifiedMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | UnifiedContent[]
  cache_control?: { type: 'ephemeral' }  // 新增
}

export type UnifiedContent =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }  // 新增
  | { type: 'image'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
```

#### 1.2 在 Anthropic Provider 中实现缓存

```typescript
// src/lib/model/anthropic.ts

async *stream(request: CompletionRequest): AsyncIterable<CompletionChunk> {
  const messages = this.convertMessages(request.messages)
  
  // 标记可缓存的内容
  const params: Anthropic.MessageCreateParams = {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages,
    stream: true,
    // 启用 Prompt Caching
    system: request.system 
      ? [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }]
      : undefined,
  }
  
  // 标记最后一个 user message 的重复内容为可缓存
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1]
    if (Array.isArray(lastMessage.content)) {
      const cacheableBlocks = lastMessage.content.filter(block => 
        block.type === 'text' && block.text.includes('<design_spec>') || 
        block.type === 'text' && block.text.includes('<theme>')
      )
      cacheableBlocks.forEach(block => {
        block.cache_control = { type: 'ephemeral' }
      })
    }
  }
  
  // ... 其余代码
}
```

#### 1.3 在 PPTD Pipeline 中标记可缓存内容

```typescript
// src/lib/pptd/pipeline.ts

function buildPagePrompt(
  outline: DeckOutline,
  page: DeckOutlinePage,
  pageIndex: number,
  theme: ReturnType<typeof getPptdThemePreset>,
  design: PptdDesignSpec,
  planning: PptdPlanningDraft | undefined,
  evidence: string,
  mediaPrompt: string,
  referencePage?: string,
): UnifiedMessage {  // 返回结构化消息而不是字符串
  const cacheableContent = [
    `<design_spec>\n${JSON.stringify(compactDesignSpec(design))}\n</design_spec>`,
    `<theme>\n${JSON.stringify(compactTheme(theme))}\n</theme>`,
  ].join('\n\n')
  
  const variableContent = [
    `生成第 ${pageIndex + 1}/${outline.pages.length} 页。只返回一个 .page YAML 文档，不要代码围栏，不要解释。`,
    // ... 其他指令
    planning ? `<planning_draft>\n${planningPromptBounds(planning, design)}\n</planning_draft>` : '',
    evidence ? `<page_evidence>\n${evidence}\n</page_evidence>` : '',
    `<page_outline>\n${JSON.stringify(page)}\n</page_outline>`,
  ].filter(Boolean).join('\n\n')
  
  return {
    role: 'user',
    content: [
      { type: 'text', text: cacheableContent, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: variableContent },
    ]
  }
}
```

**预期效果**：
- 第 1 页：正常延迟（2-5 秒），缓存 design_spec + theme
- 第 2-N 页：首字延迟降到 0.5-1.5 秒（缓存命中）
- Token 成本：输入 token 减少 60-80%

---

### 优先级 2：优化 Prompt 结构

**目标**：减少 prompt 长度，同时保持质量

#### 2.1 移除冗余指令

当前 prompt 有很多重复的约束（比如多次强调 "不要越界"、"不要重叠"）。

**优化前**：
```typescript
'页面尺寸固定为 960x540。安全边距至少 48。所有 bounds 必须是 [x,y,width,height] 且位于画布内。',
'同页 text bounds 不得重叠。正文不小于 14pt，标题不小于 28pt。',
'严格执行 visualTask、layout 和设计规范。',
```

**优化后**：
```typescript
'页面 960x540，安全边距 48。bounds=[x,y,w,h]，不越界不重叠。正文≥14pt，标题≥28pt。',
```

**预期效果**：
- 指令部分从 500 tokens 降到 300 tokens
- 首字延迟减少约 10-15%

#### 2.2 使用更紧凑的 JSON

```typescript
function compactDesignSpec(design: PptdDesignSpec): object {
  // 只保留必要字段，移除默认值
  return {
    palette: design.palette,
    typo: {  // 简化字段名
      title: design.typography.titleFont,
      body: design.typography.bodyFont,
    },
    layout: design.layout.grid ? 'grid' : 'free',  // 简化
    // 移除冗余的 compositionRules
  }
}
```

**预期效果**：
- design_spec 从 300-500 tokens 降到 150-250 tokens

---

### 优先级 3：预热连接（实验性）

**思路**：在 Design 和 Outline 阶段，提前建立连接池

```typescript
// pipeline.ts

async function generatePptdDeck(...) {
  // ... 前置代码
  
  // 预热连接池：发起一个 dummy 请求但不等待结果
  const warmupPromise = options.callModel({
    stage: 'warmup',
    system: PAGE_SYSTEM_PROMPT,
    prompt: 'warmup',
    maxTokens: 1,
  }, signal).catch(() => {/* 忽略错误 */})
  
  // 继续执行 Design 和 Outline
  design ??= await generateDesignSpec(...)
  outline ??= await generateOutline(...)
  
  // 等待 warmup 完成（如果还没完成的话）
  await warmupPromise
  
  // 开始并发生成页面（此时连接池已预热）
  const scheduler = new SubAgentScheduler(concurrency)
  // ...
}
```

**预期效果**：
- 第一批页面的首字延迟减少 200-500ms
- 需要测试是否会被 provider 拒绝（可能被识别为滥用）

---

### 优先级 4：分阶段超时

**当前问题**：所有阶段统一使用 3 分钟超时，过于保守

```typescript
// pipeline.ts

function getPptdStageTimeout(stage: string): number {
  switch (stage) {
    case 'design':
    case 'outline':
      return 90_000   // 1.5 分钟（输出较小）
    case 'planning':
      return 60_000   // 1 分钟（输出很小）
    case 'page':
      return 180_000  // 3 分钟（输出较大）
    case 'repair':
      return 120_000  // 2 分钟（通常只修改部分元素）
    case 'review':
      return 150_000  // 2.5 分钟（vision 模型较慢）
    default:
      return 180_000
  }
}

// 在 createPptdModelCaller 中使用
const completion: CompletionRequest = {
  // ...
  timeout: getPptdStageTimeout(request.stage),
}
```

**预期效果**：
- 早期阶段更快失败，不浪费时间等待超时
- 总体时间减少 5-10%

---

## 性能监控

### 添加性能指标收集

```typescript
// pipeline.ts

interface PptdDeckPipelineUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  // 新增
  stageTimings?: {
    design: number
    outline: number
    planning: number
    pages: number
    repair: number
    total: number
  }
  ttftStats?: {
    min: number
    max: number
    avg: number
    p50: number
    p95: number
  }
}
```

### 在日志中输出性能指标

```typescript
export async function generatePptdDeck(...) {
  const startTime = Date.now()
  const ttfts: number[] = []
  
  // ... 生成逻辑
  
  // 收集首字延迟
  const pageStartTime = Date.now()
  let firstTokenReceived = false
  for await (const chunk of provider.stream(completion)) {
    if (chunk.type === 'content_delta' && !firstTokenReceived) {
      ttfts.push(Date.now() - pageStartTime)
      firstTokenReceived = true
    }
    // ...
  }
  
  // 在结果中返回性能指标
  return {
    // ...
    usage: {
      // ...
      stageTimings: {
        design: designTime,
        outline: outlineTime,
        planning: planningTime,
        pages: pagesTime,
        repair: repairTime,
        total: Date.now() - startTime,
      },
      ttftStats: {
        min: Math.min(...ttfts),
        max: Math.max(...ttfts),
        avg: ttfts.reduce((a, b) => a + b, 0) / ttfts.length,
        p50: percentile(ttfts, 0.5),
        p95: percentile(ttfts, 0.95),
      }
    }
  }
}
```

---

## 预期效果总结

| 优化方案 | 首字延迟改善 | 总时间改善 | 成本改善 | 实现难度 |
|---------|------------|----------|---------|---------|
| Prompt Caching | -50~70% | -20~30% | -60~80% | 中等 |
| 优化 Prompt 结构 | -10~15% | -5~10% | 0% | 低 |
| 预热连接 | -10~20% | -5~10% | 0% | 低（实验性）|
| 分阶段超时 | 0% | -5~10% | 0% | 低 |
| **组合效果** | **-60~80%** | **-30~50%** | **-60~80%** | - |

**具体数字**：
- 首字延迟：从 2-5 秒降到 0.5-1.5 秒
- 10 页 PPT：从 180-360 秒降到 120-200 秒
- Token 成本：输入 token 减少 60-80%

---

## 下一步行动

1. **立即**：测试智能并发度的效果（已实现）
2. **本周**：实现 Prompt Caching（最大收益）
3. **下周**：优化 Prompt 结构 + 分阶段超时
4. **未来**：实验预热连接、监控性能指标

---

## 参考资料

- [Anthropic Prompt Caching 文档](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [PPTD Pipeline 源码](../src/lib/pptd/pipeline.ts)
- [并发优化提交](https://github.com/yourusername/solidify/commit/6d08c80)
