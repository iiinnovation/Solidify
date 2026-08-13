# M1 · AI 交互引擎与工具系统

| | |
|---|---|
| **层** | L1 + L2 |
| **工期** | 4–5 周（约 22–25 pd） |
| **前置** | M0（见 [03-roadmap.md §6](../03-roadmap.md)） |
| **规格** | [specs/agent-loop.md](../specs/agent-loop.md)、[specs/tool-interface.md](../specs/tool-interface.md) |
| **特性开关** | `agentLoop`、`toolCalling` |

## 目标

把单轮流式对话升级为**可循环、可中断、可恢复的 Agent 运行时**，并交付第一批工具。

这是整个改造的地基。四根支柱全部依赖 L1/L2，M1 不完成后面全是空中楼阁。

## Demo（验收标准）

> 在一个本地目录下输入：「看看当前目录有什么文件，把最大的那个读出来并总结要点」
>
> AI 连续调用 `list_dir` → `read_file` → 输出总结。UI 上逐步显示每一次工具调用及其结果，中途点「停止」能立即中断且不留残留。

## 任务清单

### A. 类型与骨架（3 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-01 | 定义 Tool / ToolUseContext / ToolResult 全套类型 | `src/lib/tools/types.ts` | 1pd | ✅ |
| M1-02 | 定义 QueryContext / QueryEvent / RunLimits | `src/lib/engine/types.ts` | 1pd | ✅ |
| M1-03 | 工具注册表：register / resolve / toSchema | `src/lib/tools/registry.ts` | 1pd | ✅ |

**实现说明**（commit 4877b01）：

M1-01/02/03 按照规格要求一起设计并提交，包含：
- **工具类型**：`Tool`、`ToolCall`、`ToolResult`、`ToolUseContext`、`ToolError`
- **引擎类型**：`QueryContext`、`QueryEvent`、`RunLimits`、`UsageStats`
- **工具注册表**：类型安全的注册/查找/schema 生成，带权限检查钩子
- **查询循环骨架**：`runQuery()` async generator（M1-08 的基础框架）
- **日志系统**：`SimpleRunLogger` 结构化日志

同时创建了 harness、memory、skills、workspace 类型骨架，为后续阶段提供前向兼容性。

### B. Model Gateway（4 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-04 | 上下文组装与消息构建 | `src/lib/engine/messages.ts` | 1pd | ✅ |
| M1-05 | 多 Provider 架构 + 工具 schema 生成 | `src/lib/model/*` + `src/lib/engine/model.ts` | 1pd | ✅ |
| M1-06 | SSE 解析扩展：支持工具调用增量 | `src/lib/engine/stream-parser.ts` | 1.5pd | ✅ |
| M1-07 | Edge Function 透传 tools 参数 | `supabase/functions/_shared/ai-providers.ts`、`chat/index.ts` | 0.5pd | ✅ |

**架构调整说明**：

M1-04/05 实际实现采用了更完整的架构方案：
- **M1-04**：实现了消息构建和上下文组装（`messages.ts`）
- **M1-05**：实现了完整的多 provider 架构（`src/lib/model/`），包含：
  - 统一类型定义（`types.ts`）
  - Provider 接口（`provider.ts`）
  - Anthropic 实现（`anthropic.ts`，含 `convertTools()`）
  - OpenAI 实现（`openai.ts`，含 `convertTools()`）
  - Provider 注册表（`registry.ts`）
  - Engine 桥接层（`src/lib/engine/model.ts`）

**M1-06 关键实现细节**：

两家的工具调用增量格式差异大，已在 `stream-parser.ts` 中统一处理：
- OpenAI：`delta.tool_calls[].function.arguments` 分片拼接，按 index 累积
- Anthropic：`content_block_start` + `input_json_delta` + `content_block_stop`

输出统一的 `QueryEvent` 格式（`tool_call_start`/`delta`/`end`），供上层消费。

**M1-07 关键实现细节**：

Edge Function 现在支持完整的工具调用流程：
- 请求体新增 `tools?: ToolDefinition[]` 参数
- 透传给 provider 的 `createCompletion()` 方法
- Provider 内部转换为各自的格式（Anthropic/OpenAI）
- 修复了测试中的类型问题，使 `convertMessages/convertTools` 可测试

### C. 查询循环（7 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-08 | 主循环 async generator | `src/lib/engine/query.ts` | 2pd | ✅ |
| M1-09 | 上下文组装 + 裁剪策略 | `src/lib/engine/context-budget.ts` | 1.5pd | ✅ |
| M1-10 | 大结果句柄化 | `src/lib/engine/handle-store.ts` | 1pd | ⏳ 部分 |
| M1-11 | Tombstoning 全套场景 | 分布式实现，见说明 | 1pd | ✅ |
| M1-12 | 中断：AbortSignal 贯穿 + finally 清理 | 循环内 | 1pd | ✅ |
| M1-13 | 会话快照与恢复（jsonl 追加） | `src/lib/engine/snapshot.ts` | 0.5pd | |

**实现说明**：

产出文件与计划名不同：主循环在 `query.ts`（非 `query-loop.ts`），上下文组装在 `context-budget.ts` + `messages.ts`（非 `build-context.ts`）。

**Stop reason 处理**（commit 00a8fcc，提交信息误标为 M1-10）：属于规格 §1 的循环逻辑 —— 提取 Anthropic `stop_reason` 映射为统一 `StopReason` 类型，主循环区分模型级 token 耗尽（`stop_reason: max_tokens`）与预算级耗尽（`RunLimits.maxTokens`）。

**M1-10 现状**：`context-budget.ts` 的 `handleizeLargeResult()` 已做超过 8KB 的内联截断兜底，但完整的句柄存储/取回（`handle-store.ts`）依赖 M2 的存储层，暂缓。

**M1-11 关键实现细节**：

规格 §3 的 4 个场景全部落地，墓碑逻辑就近实现在各发生点而非集中在 `tombstone.ts`：

| 场景 | 位置 | 处理 |
|---|---|---|
| `tool_use` 参数缺失必填项 | `query.ts` `executeTools()` | 墓碑 + 校验错误回灌（完整 JSON Schema 校验留给 M1-14） |
| 未知工具名 | `query.ts` `executeTools()` | 墓碑 + 回灌可用工具列表让模型自纠 |
| SSE 帧解析失败 / 工具输入 JSON 畸形 | `anthropic.ts` 产出 `recoverable` 错误 → `query.ts` 转墓碑跳过 | 会话不中断，账本记录 |
| 孤儿 tool_result | `context-budget.ts` `removeOrphanToolResults()` | 从上下文剔除（事件流集成留 M1-14 TODO） |

配套改动：
- `ModelError` 增加 `kind`（parse/validation/network/auth）与 `recoverable` 字段，`query.ts` 据此区分「墓碑跳过」与「致命抛出」
- 修复 `anthropic.ts` 两处阻塞性 bug：`tool_call_delta` 误用 `event.index` 作 id 导致增量无法归并到 `content_block.id` 开启的调用；`content_block_stop` 从不产出 `tool_call_end` 导致工具调用永远无法完成

**M1-12 关键实现细节**（规格 §4）：

- **Signal 贯穿**：`CompletionRequest` 增加 `signal` 字段，`runQuery` → `streamModel` → provider SDK（`messages.stream(body, { signal })` / `chat.completions.create(body, { signal })`），abort 时在途 HTTP 请求立即取消，不泄漏
- **内部 AbortController**：`runQuery` 内部创建 controller 并用 `linkAbort()` 与外部 signal 联动，下游统一消费内部 signal。这样消费端 `gen.return()`（for-await break）提前退出时，`finally` 中 `internal.abort()` 也能取消在途请求 —— 仅靠外部 signal 做不到这点
- **工具间中断点**：`executeTools` 每个调用前检查 signal；abort 时已完成结果保留不回滚，剩余调用合成 `kind: 'aborted'` 的 tool_result，保证历史中每个 `tool_use` 都有配对结果（为 M1-13 快照恢复铺路）
- **测试**：`__tests__/query-abort.test.ts` 覆盖 5 个场景 —— 启动前 abort、流中 abort（含请求取消断言）、工具间 abort（已完成保留 + 剩余 aborted）、`gen.return()` finally 清理、正常完成不受影响

### D. 工具执行（3 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M1-14 | 执行调度：校验 → 执行 → 规范化 | `src/lib/tools/executor.ts` | 1.5pd |
| M1-15 | 并发策略（只读且 concurrencySafe 才并行） | 同上 | 0.5pd |
| M1-16 | 超时与重试 | 同上 | 1pd |

### E. 首批工具（5 pd）

| # | 工具 | 产出文件 | 估时 | 备注 |
|---|---|---|---|---|
| M1-17 | `list_dir` | `src/lib/tools/builtin/list-dir.ts` + Rust | 1pd | Rust 侧用 `ignore` crate |
| M1-18 | `read_file` | `builtin/read-file.ts` | 0.5pd | 支持 offset/limit |
| M1-19 | `write_file` | `builtin/write-file.ts` | 0.5pd | 确认逻辑留到 M2，M1 先无条件允许 |
| M1-20 | `search_files` | `builtin/search-files.ts` + Rust | 1pd | 内容 + 文件名 |
| M1-21 | `capture_preview` | `builtin/capture-preview.ts` | 1pd | 截 artifact 渲染结果，M5 依赖 |
| M1-22 | **路径沙箱（Rust）+ 7 个强制测试用例** | `src-tauri/src/fs/sandbox.rs` | 1pd | 见 [tool-interface.md §8](../specs/tool-interface.md) |

⚠️ M1-22 不能跳过也不能推迟。M1-19 让模型有了写文件能力，同一个迭代内必须有沙箱，否则测试期间就可能损坏用户数据。

### F. UI（4 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M1-23 | 运行过程视图：逐步展示工具调用与结果 | `src/components/agent/run-timeline.tsx` | 2pd |
| M1-24 | 工具调用卡片（可折叠、显示耗时、错误态） | `src/components/agent/tool-call-card.tsx` | 1pd |
| M1-25 | 停止按钮 + 运行状态指示 | `src/components/agent/run-controls.tsx` | 0.5pd |
| M1-26 | `use-chat.ts` 接入新引擎（开关控制新旧路径） | `src/hooks/use-chat.ts` | 0.5pd |

M1-26 的做法：`use-chat.ts` 保持现有单轮路径不动，新增一条走 `runQuery` 的路径，由 `flags.agentLoop` 决定走哪条。**不要重写 `use-chat.ts`** —— 它现有的 artifact 流式解析逻辑仍然要用。

### G. 测试（3 pd）

| # | 任务 | 估时 |
|---|---|---|
| M1-27 | 循环单元测试（[agent-loop.md §7](../specs/agent-loop.md) 的 7 个用例） | 1.5pd |
| M1-28 | 沙箱测试（7 个强制用例） | 0.5pd |
| M1-29 | 端到端：Demo 场景在 3 个模型上跑通 | 1pd |

## 里程碑内的顺序建议

```
第 1 周   A（类型骨架）+ B（Gateway）
第 2 周   C（循环主体）
第 3 周   D（执行）+ E（工具，含沙箱）
第 4 周   F（UI）
第 5 周   G（测试）+ 缓冲
```

第 5 周留缓冲不是客气 —— M1-06 的两家 SSE 格式适配和 M1-29 的多模型验证，经验上都会超预期。

## 风险

| 风险 | 应对 |
|---|---|
| 国产模型工具调用不稳定（不返回 tool_use、参数格式乱） | 能力探测 + 降级为纯对话；先用 Claude/GPT 打通，DeepSeek 等逐个适配并记录已知问题 |
| 循环失控烧 token | `RunLimits` 从第一天就生效，默认值保守（maxTurns=25） |
| 背压实现不正确导致内存增长 | M1-27 加专项用例：消费端暂停 5 秒观察内存 |
| Rust 侧首次开发效率低 | 优先用成熟 crate；沙箱逻辑先写测试再写实现 |

## 完成定义

- [ ] Demo 能当着人跑通，且在 Claude / GPT / DeepSeek 三个模型上都验证过
- [ ] `flags.agentLoop = false` 时，应用行为与改造前完全一致
- [ ] [agent-loop.md §7](../specs/agent-loop.md) 的 7 个用例全部通过
- [ ] 沙箱 7 个强制用例全部通过
- [ ] 一次运行的 token 用量可在 UI 上看到
