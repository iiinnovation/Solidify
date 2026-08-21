# spec · Agent 查询循环

> 约束模块：`src/lib/engine/`　对应里程碑：[M1](../phases/M1-agent-runtime.md)
> 参考：[reference/core_tech_extraction.md](../reference/core_tech_extraction.md) §1

## 1. 核心形态

查询引擎是一个 **async generator**，产出事件流，由 UI 消费驱动：

```ts
async function* runQuery(ctx: QueryContext): AsyncGenerator<QueryEvent> {
  let turn = 0

  while (turn < ctx.limits.maxTurns) {
    turn++

    // 1. 组装本轮消息（system + skill + history + memory 摘要）
    const messages = await buildMessages(ctx)

    // 2. 调用模型，流式产出
    const response = yield* streamModel(ctx, messages)

    // 3. 无工具调用 → 任务结束
    if (response.toolCalls.length === 0) {
      yield { type: 'message.completed', content: response.text }
      return
    }

    // 4. 有工具调用 → 执行并回灌
    const results = yield* executeTools(ctx, response.toolCalls)
    ctx = appendResults(ctx, response, results)   // 返回新 ctx，不原地修改
  }

  yield { type: 'run.exhausted', reason: 'max_turns' }
}
```

**为什么必须是 generator 而不是回调或 Promise 链**：

1. **背压** —— 消费端（React）不 `next()`，管线就不推进。模型高速输出时不会在内存里堆积待渲染的增量。
2. **可挂起** —— 权限 `ask` 需要循环真正停在那里等用户，generator 天然支持。
3. **可中断** —— 消费端 `return()` 即触发 `finally`，资源清理路径统一。

## 2. 类型定义

```ts
/** 一次运行的上下文，不可变 */
export interface QueryContext {
  readonly runId: string
  readonly conversationId: string
  readonly cwd: string                      // 工作目录 = 项目根
  readonly messages: readonly Message[]
  readonly tools: readonly Tool[]           // 本次可用工具（已过权限与环境过滤）
  readonly skill?: LoadedSkill
  readonly memory: MemoryState
  readonly model: ModelConfig
  readonly limits: RunLimits
  readonly signal: AbortSignal
}

export interface RunLimits {
  maxTurns: number          // 默认 25
  maxTokens: number         // 单次运行 token 上限，超出中止
  maxProviderTokens?: number // Provider 实际累计 input+output 硬上限
  maxToolCalls: number      // 默认 50
  toolTimeoutMs: number     // 单工具超时，默认 60_000
  toolLoopBudgets?: Readonly<Record<string, {
    maxCalls: number
    softThreshold?: number
    hardThreshold?: number
  }>>                     // 可选的结果感知循环/检索预算
}

/** 事件流 */
export type QueryEvent =
  | { type: 'run.started';         runId: string }
  | { type: 'model.progress';      phase: 'preparing' | 'reasoning' | 'generating' | 'tool_call'; observedChars?: number }
  | { type: 'message.delta';       text: string }
  | { type: 'message.completed';   content: string }
  | { type: 'tool.requested';      call: ToolCall }
  | { type: 'permission.required'; requestId: string; callId: string; prompt: ConfirmationPrompt }
  | { type: 'permission.resolved'; requestId: string; callId: string; outcome: ApprovalOutcome }
  | { type: 'tool.progress';       callId: string; progress: ToolProgress }
  | { type: 'tool.completed';      callId: string; result: ToolResult }
  | { type: 'artifact.created';    artifact: ArtifactRef }
  | { type: 'tombstone';           reason: string; detail?: unknown }
  | { type: 'run.completed';       usage: UsageStats }
  | { type: 'run.failed';          error: RunError }
  | { type: 'run.exhausted';       reason: 'max_turns' | 'max_tokens' | 'max_output_tokens' | 'max_tool_calls' | 'tool_loop' }
```

事件遵循 [ADR-0008](../04-decisions.md#adr-0008)：UI 与账本共享领域命名和 `runId` / `callId` / `requestId`，但不是同一个序列化投影。`message.delta`、`model.progress`、`tool.progress`、`permission.required` 属于可丢弃的实时控制事件；账本只保存无损 JSON 的稳定事实。`model.progress` 只携带阶段和计数，禁止携带原始思维链。禁止把 Promise resolver、`AbortSignal` 或其他运行时对象放入账本。

这不是维护两套状态机：执行边界只产生一次领域事实，实时总线与账本分别投影所需形态。模型实际看到的消息、工具结果和权限拒绝必须能从持久事实重建。

## 3. Tombstoning

当出现下列情况时，**产出墓碑事件而不是抛异常**：

| 情况 | 处理 |
|---|---|
| 模型返回的 `tool_use` 参数不符合 schema | 墓碑 + 把校验错误作为 tool_result 回灌，让模型自己改 |
| 工具调用引用了不存在的工具名 | 墓碑 + 回灌「无此工具」，附上可用工具列表 |
| SSE 流中出现无法解析的帧 | 墓碑，跳过该帧继续 |
| 消息历史中出现孤儿 tool_result（没有对应 tool_use） | 墓碑，从上下文中剔除 |

**原则：会话不因单点异常而中断。** UI 可以完全隐藏墓碑事件，但账本必须记录。

反例（不要这样写）：

```ts
// ❌ 一个畸形工具调用炸掉整个会话
const args = JSON.parse(call.arguments)   // throw → 用户看到白屏
```

```ts
// ✅
const parsed = safeParse(call.arguments, tool.inputSchema)
if (!parsed.ok) {
  yield { type: 'tombstone', reason: 'invalid_tool_args', detail: parsed.error }
  results.push(toolErrorResult(call.id, parsed.error))   // 回灌让模型自纠
  continue
}
```

## 4. 中断与恢复

### 中断

```ts
const controller = new AbortController()
const gen = runQuery({ ...ctx, signal: controller.signal })

// 用户点停止
controller.abort()
await gen.return(undefined)   // 触发 finally，清理进行中的工具
```

要求：

- 进行中的工具收到 `signal`，自行取消（HTTP 请求 abort、子进程 kill）
- 已完成的工具结果**保留**并写入历史，不回滚
- 产出 `run.failed { error: { kind: 'aborted' } }` 并落账本

### 恢复

每轮循环结束后写一次快照到 `.solidify/conversations/<id>.jsonl`（追加一行）：

```json
{"turn":3,"messages":[...],"usage":{...},"ts":"2026-08-11T15:04:05Z"}
```

恢复时读最后一行重建 `QueryContext` 继续。

⚠️ 首版只做「刷新页面/重开应用后可从断点继续」，**不做「关窗后后台继续跑」**。见 [ADR-0002](../04-decisions.md#adr-0002) 的已知限制。

## 5. Model Gateway

统一两种 wire format，向上暴露一致接口：

```ts
export interface ModelGateway {
  capabilities(model: ModelConfig): ModelCapabilities
  stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelChunk>
}

export interface ModelCapabilities {
  tools: boolean          // 是否支持工具调用
  parallelTools: boolean  // 是否支持单轮多工具
  vision: boolean         // 是否支持图片输入（capture_preview 自检需要）
  maxContext: number
}
```

**能力探测是必需的**：不支持 `tools` 的模型自动降级为纯对话模式（走现有 `<solidify-artifact>` 标签路径），而不是报错。这条决定了改造期间老功能不受影响。

格式差异对照：

| | OpenAI 系 | Anthropic 系 |
|---|---|---|
| 工具声明 | `tools: [{type:'function', function:{...}}]` | `tools: [{name, description, input_schema}]` |
| 工具调用增量 | `delta.tool_calls[].function.arguments` 分片拼接 | `content_block_delta` + `input_json_delta` |
| 结果回灌 | `role:'tool', tool_call_id` | `role:'user'` + `content:[{type:'tool_result'}]` |
| 文本增量 | `choices[0].delta.content` | `content_block_delta.delta.text` |

现有 `src/lib/chat-api.ts` 已处理文本增量的两种格式（`use-chat.ts:318-321`），工具增量需新增。

## 6. 上下文组装规则

每轮重新组装，优先级从高到低，超出预算时从低优先级开始裁剪：

```
1. System 核心规则（人格 + 环境 + 输出契约）     不裁
2. 当前 Skill 核心规则                           预注入最多 2k token，详情按需读取
3. 工具 schema                                      纳入上下文预算
4. 当前用户任务与最近对话                          按 tool pair 成组裁剪
5. 工具结果                                         单项句柄化 + 全局累计上限
6. 记忆检索片段                                     独立插槽预算，仅首轮注入
```

### 6.1 结果感知的工具循环保护

仅依赖 `maxTurns` 会让“相同工具、不同参数、相同结果”的检索循环烧完整个预算。可循环工具通过 `Tool` 元数据声明 `loopGroup`、`loopKey` 和可选的 `replaySafe`，引擎为每个组维护：

- 规范化参数签名，识别连续相同调用；
- 结果摘要签名，识别无新证据的重复读取和 A→B→A→B 往返；
- 组级与子键级调用预算；
- 软提示一次、随后关闭检索组，并在下一轮隐藏该组工具；
- 模型仍无视关闭信号时，产出 `run.exhausted{tool_loop}`，不继续消耗剩余轮次。

附件检索默认采用 `search` 最多 3 次、`read` 最多 6 次、组内最多 10 次。达到预算后只保留已有证据，进入生成阶段。

### 6.2 工具结果的本地去重

在累计 `tool_result` 插槽和通用历史裁剪之前，先做零 LLM 成本的重复结果折叠：相同的长结果只保留最新正文，旧的 `tool_result` 替换为短标记；工具配对本身不删除。这样重复附件读取不会在每一轮上下文中复制完整正文，也不会引入额外的总结模型往返。

### 6.3 设计参考与取舍

- [Cline loop detection](https://github.com/cline/cline/blob/main/sdk/packages/core/src/runtime/safety/loop-detection.ts)：借鉴稳定参数签名和 soft/hard 两级阈值；本项目额外比较结果摘要，避免只识别完全相同的参数。
- [ZeroClaw result-aware loop detection](https://github.com/zeroclaw-labs/zeroclaw/issues/2152)：借鉴“相同输入与相同结果”“A→B→A→B”“连续失败”三类无进展信号；同输入但结果变化的分页读取不应误判。
- [Hermes context compressor](https://github.com/NousResearch/hermes-agent/blob/main/agent/context_compressor.py)：借鉴零模型成本的旧工具结果去重、折叠和 pair sanitation；不把辅助 LLM 总结放入关键路径，避免增加 TTFT 或因总结模型窗口不足丢失上下文。
- [SkimSearchAgent](https://github.com/ielab/skim-search-agent)：借鉴有预算的 Search→Inspect→Fetch→Answer 阶段划分；达到检索预算后由引擎隐藏检索工具，而不是依赖模型自行停止。

这些机制互补而不互相替代：硬预算限制最坏成本，结果感知检测负责提前发现无进展，本地折叠控制每轮输入，阶段切换保证最终仍有一次生成机会。

**大结果句柄化**（关键机制）：

```ts
if (byteLength(result.data) > HANDLE_THRESHOLD) {   // 默认 24KB
  const handle = await memory.store(result.data)
  return {
    summary: truncate(result.data, 500),
    handle,                                          // 模型可用 read_handle 取全文
    truncated: true,
  }
}
```

句柄化只解决“单个大结果”。多个小结果仍可能累积失控，因此每次模型请求还必须对所有 `tool_result` 实施累计 token 上限，优先保留最新结果。推理模型如果只消耗输出预算而没有产生正文或工具调用，引擎自动进入 `compact_recovery`、精简输入后重试一次，不把换模型或修改额度作为首选恢复手段。

## 7. 验收测试

| 用例 | 期望 |
|---|---|
| 连续 3 次工具调用完成任务 | 事件流顺序正确，最终 `run.completed` |
| 模型返回畸形 JSON 参数 | 产出 tombstone，回灌校验错误，模型自纠后成功 |
| 第 2 轮中途中断 | 已完成工具结果保留，`run.failed{aborted}`，无泄漏的子进程/请求 |
| 达到 maxTurns | `run.exhausted{max_turns}`，不无限循环 |
| 不支持 tools 的模型 | 降级为纯对话，不报错 |
| 读取 10MB 文件 | 结果句柄化，上下文不爆 |
| 消费端暂停 5 秒不 next() | 模型流不在内存堆积（背压生效） |
