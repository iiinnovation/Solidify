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

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M1-01 | 定义 Tool / ToolUseContext / ToolResult 全套类型 | `src/lib/tools/types.ts` | 1pd |
| M1-02 | 定义 QueryContext / QueryEvent / RunLimits | `src/lib/engine/types.ts` | 1pd |
| M1-03 | 工具注册表：register / resolve / toSchema | `src/lib/tools/registry.ts` | 1pd |

> M1-01 和 M1-02 要一起设计再一起提交。两组类型的耦合点（`ToolCall`、`ToolResult` 在事件流中的形状）分开定会返工。

### B. Model Gateway（4 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-04 | 上下文组装与消息构建 | `src/lib/engine/messages.ts` | 1pd | ✅ |
| M1-05 | 多 Provider 架构 + 工具 schema 生成 | `src/lib/model/*` + `src/lib/engine/model.ts` | 1pd | ✅ |
| M1-06 | SSE 解析扩展：支持工具调用增量 | `src/lib/engine/stream-parser.ts` | 1.5pd | ✅ |
| M1-07 | Edge Function 透传 tools 参数 | `supabase/functions/_shared/ai-providers.ts`、`chat/index.ts` | 0.5pd | 🔲 |

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

### C. 查询循环（7 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M1-08 | 主循环 async generator | `src/lib/engine/query-loop.ts` | 2pd |
| M1-09 | 上下文组装 + 裁剪策略 | `src/lib/engine/build-context.ts` | 1.5pd |
| M1-10 | 大结果句柄化 | `src/lib/engine/handle-store.ts` | 1pd |
| M1-11 | Tombstoning 全套场景 | `src/lib/engine/tombstone.ts` | 1pd |
| M1-12 | 中断：AbortSignal 贯穿 + finally 清理 | 循环内 | 1pd |
| M1-13 | 会话快照与恢复（jsonl 追加） | `src/lib/engine/snapshot.ts` | 0.5pd |

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
