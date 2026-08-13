# M1 · AI 交互引擎与工具系统

| | |
|---|---|
| **层** | L1 + L2 |
| **工期** | 4–5 周（约 22–25 pd） |
| **前置** | M0（见 [03-roadmap.md §6](../03-roadmap.md)） |
| **规格** | [specs/agent-loop.md](../specs/agent-loop.md)、[specs/tool-interface.md](../specs/tool-interface.md) |
| **特性开关** | `agentLoop`、`toolCalling` |
| **归档状态** | 条件验收：功能与本地门禁完成，真实模型 E2E 通过 2/3；Claude 因外部中转阻塞暂缓，不计为通过 |

> **归档决定（2026-08-13）**：M1 以条件验收状态形成稳定检查点并允许进入 M2。M1-29 的三模型完成定义保持未勾选；待 Claude 中转恢复后必须重跑真实验收，再单独关闭该项。

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

Provider 配置包含显式 `supportsTools` 能力位，旧配置缺省为支持；自定义或旧模型可在设置页关闭「支持工具调用」。Gateway 据该能力位同时移除请求 tools schema 与 system prompt 工具说明，稳定降级为纯对话，不通过失败后重试来探测，避免重复计费或副作用。

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
| M1-10 | 大结果句柄化 | `src/lib/memory/in-memory.ts` + `read_handle` | 1pd | ✅ |
| M1-11 | Tombstoning 全套场景 | 分布式实现，见说明 | 1pd | ✅ |
| M1-12 | 中断：AbortSignal 贯穿 + finally 清理 | 循环内 | 1pd | ✅ |
| M1-13 | 会话快照与恢复（jsonl 追加） | `src/lib/engine/snapshot.ts` | 0.5pd | ✅ |

**实现说明**：

产出文件与计划名不同：主循环在 `query.ts`（非 `query-loop.ts`），上下文组装在 `context-budget.ts` + `messages.ts`（非 `build-context.ts`）。

**Stop reason 处理**（commit 00a8fcc，提交信息误标为 M1-10）：属于规格 §1 的循环逻辑 —— 提取 Anthropic `stop_reason` 映射为统一 `StopReason` 类型，主循环区分模型级 token 耗尽（`stop_reason: max_tokens`）与预算级耗尽（`RunLimits.maxTokens`）。

**M1-10 实现**：UTF-8 编码后超过 8KB 的工具结果写入每次运行独享的 `InMemoryState`，模型上下文和持久化运行事件只保留摘要与 handle；`read_handle` 用 `offset` / `limit` 分块取回（单次最多 8000 字符且不超过 8000 字节），避免多字节文本取回时再次句柄化。相同结果重复组装时复用 handle。M1 的 handle 故意不跨进程持久化：重启后恢复的历史如引用旧 handle，`read_handle` 会返回可恢复的 `not_found`，模型据此重新执行源工具；该完整闭环有快照集成测试覆盖。M3 再按既定接口替换为 `.solidify/cache/` 持久化实现。

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

**M1-13 关键实现细节**（规格 §4 恢复）：

- 每个工具轮结束后追加一行快照 `{runId, turn, messages, usage, ts}`；快照写入失败只记账不中断运行
- 双端存储：Tauri 通过专用 Rust 命令写 `<workspace>/.solidify/conversations/<id>.jsonl`，服务端固定目录并复用 canonical 工作区沙箱，不依赖重启后丢失的 Tauri dialog 动态 fs scope；Web 降级 localStorage（每会话保留最近 20 条防爆配额）
- 恢复读最后一行重建消息历史：`readLatestSnapshot()` 从尾部回扫，跳过写一半的残行（崩溃时的 torn write），不因尾行损坏丢掉全部历史
- 聊天消息持久化本次运行的 Provider ID、Skill prompt 与工作区引用；每条快照带 `runId` 所有权，刷新/重开后，仅对仍为 `running` 且 runId 匹配的 assistant 运行自动设置 `restoreSnapshot` 并续跑一次，不重复追加用户消息。新运行开始前清除旧恢复点，停止/失败/耗尽状态不会自动续跑
- `QueryContext` 新增可选 `snapshots?: SnapshotStore`，不传则不写快照，现有调用零破坏
- conversationId 进文件名前做字符白名单清洗，防路径穿越
- 按 ADR-0002 限制：只支持「刷新/重开后从断点继续」，不做后台续跑

### D. 工具执行（3 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-14 | 执行调度：校验 → 执行 → 规范化 | `src/lib/tools/executor.ts` | 1.5pd | ✅ |
| M1-15 | 并发策略（只读且 concurrencySafe 才并行） | 同上 | 0.5pd | ✅ |
| M1-16 | 超时与重试 | 同上 | 1pd | ✅ |

**实现说明**（规格 tool-interface.md §4/§5）：

执行流程 ①②③⑥⑦⑨ 全部落地；④ before_tool_call Hook 与 ⑤ PolicyEngine 按计划留到 M2（M1 无条件允许，与 M1-19 备注一致）。

- **prepareCall（①②③）**：① 未知工具 → 墓碑 + 回灌可用列表；② tauri-only 工具在 web → `permission_denied` 回灌（不发墓碑，registry.resolve 是第一道过滤，此处是纵深防御，platform 未知时跳过）；③ 自研 JSONSchema 子集校验器（type/required/properties/items/enum/min-max/pattern，递归带路径的错误信息）→ 墓碑 + 校验错误回灌。③ 在权限判定之前，符合规格硬要求
- **executeCall（⑥⑦，M1-16）**：每次尝试独立 AbortController（外部 abort 或超时都触发）；`raceWithAbort` 保证无视 signal 的工具也挂不死循环；超时 → `timeout` 可恢复错误；异常 → 转可解释的 `runtime` 错误；按工具声明的 `retry{maxAttempts, backoffMs}` 线性退避重试，只重试 timeout/runtime 且退避睡眠可中断；⑦ 规范化补 `durationMs`、超过 8KB 内容句柄化截断并标记 `truncated`。永不 throw，总是返回 ToolResult
- **canRunInParallel（M1-15）**：全部调用 readOnly && concurrencySafe 才并行（保守策略），并行时先全部启动、按模型返回顺序 yield 完成事件；其余串行，M1-12 的工具间中断点保留在串行路径
- **ToolUseContext 合成**（`engine/tool-context.ts`）：QueryContext 新增可选 workspace/settings/permissions/platform 字段，聊天入口注入用户选择的真实根目录、设置与平台；其他调用方缺省时使用保守兜底，platform 默认 `web` 以阻断 tauri-only 工具
- **测试**：executor 单元 24 例（校验/准备/超时/重试/中断/UTF-8 句柄化/并发判定）+ 循环集成 4 例（视觉结果回灌、并行交错、混合未知工具批次、校验错误自纠后成功）

### E. 首批工具（5 pd）

| # | 工具 | 产出文件 | 估时 | 备注 |
|---|---|---|---|---|
| M1-17 | `list_dir` | `src/lib/tools/builtin/list-dir.ts` + Rust | 1pd | ✅ `ignore` crate + `.solidifyignore` |
| M1-18 | `read_file` | `builtin/read-file.ts` | 0.5pd | ✅ offset/limit + 二进制元信息 |
| M1-19 | `write_file` | `builtin/write-file.ts` | 0.5pd | ✅ 确认逻辑留到 M2，M1 先无条件允许 |
| M1-20 | `search_files` | `builtin/search-files.ts` + Rust | 1pd | ✅ 内容 + 文件名 |
| M1-21 | `capture_preview` | `builtin/capture-preview.ts` | 1pd | ✅ 截图回灌为视觉模型图像输入 |
| M1-22 | **路径沙箱（Rust）+ 7 个强制测试用例** | `src-tauri/src/fs/sandbox.rs` | 1pd | ✅ Rust 安全边界，8 个测试 |

⚠️ M1-22 不能跳过也不能推迟。M1-19 让模型有了写文件能力，同一个迭代内必须有沙箱，否则测试期间就可能损坏用户数据。

**实现说明**：

- 四个文件工具先经 TS `WorkspaceHandle` 提前拒绝绝对路径与越界路径，再调用 Tauri Rust command；Rust 侧 canonicalize 后做权威工作区包含校验，写入不存在文件时先校验最近存在祖先，创建目录后再次校验
- `list_dir` / `search_files` 使用 `ignore` crate，支持 `.solidifyignore`，并跳过工作区规格规定的版本库、依赖、缓存和临时文件
- `read_file` 的 offset/limit 按 Unicode 字符切片，二进制文件不内联；`write_file` 可安全创建嵌套父目录
- `capture_preview` 捕获当前 artifact DOM，工具结果中的 data URL 会作为下一轮视觉模型的图像内容回灌；Anthropic 转原生 base64 image block
- 沙箱测试覆盖父目录穿越、外部符号链接、绝对路径、Windows UNC、大小写文件系统行为、正常相对路径和内部符号链接，并额外覆盖安全创建嵌套路径

### F. UI（4 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M1-23 | 运行过程视图：逐步展示工具调用与结果 | `src/components/agent/run-timeline.tsx` | 2pd | ✅ |
| M1-24 | 工具调用卡片（可折叠、显示耗时、错误态） | `src/components/agent/tool-call-card.tsx` | 1pd | ✅ |
| M1-25 | 停止按钮 + 运行状态指示 | `src/components/agent/run-controls.tsx` | 0.5pd | ✅ |
| M1-26 | `use-chat.ts` 接入新引擎（开关控制新旧路径） | `src/hooks/use-chat.ts` | 0.5pd | ✅ |

M1-26 的做法：`use-chat.ts` 保持现有单轮路径不动，新增一条走 `runQuery` 的路径，由 `flags.agentLoop` 决定走哪条。**不要重写 `use-chat.ts`** —— 它现有的 artifact 流式解析逻辑仍然要用。

桌面端在输入区选择真实工作目录后，才向模型暴露 `list_dir` / `read_file` / `write_file` / `search_files`；该目录同时进入 `cwd`、`WorkspaceHandle`、设置与快照存储。目录选择由专用 Rust 命令打开原生 picker，renderer 无法自报待授权根；Rust 在应用配置目录持久化 canonical 根，每个文件工具与快照 IPC 都要求 renderer 传入的根与已授权根完全一致，不信任 LocalStorage 中的根。Web 端以及未选择目录时均不暴露桌面文件工具。此处仅完成 M1 Demo 所需的根目录注入，不包含 M3 的索引、监听或文件树。

设置页「实验能力」提供 `agentLoop` / `toolCalling` 两个独立开关，仍保持默认关闭；用户无需手改 LocalStorage 即可启用 M1 Demo。Provider 编辑表单同时提供「支持工具调用」能力声明，不支持 tools 的模型会显示为「纯对话」。900×600（Tauri 最小窗口）与 1280×900 视觉烟测均无裁切或重叠；项目范围明确不支持移动端。

### G. 测试（3 pd）

| # | 任务 | 估时 | 状态 |
|---|---|---|---|
| M1-27 | 循环单元测试（[agent-loop.md §7](../specs/agent-loop.md) 的 7 个用例） | 1.5pd | ✅ |
| M1-28 | 沙箱测试（7 个强制用例） | 0.5pd | ✅ |
| M1-29 | 端到端：Demo 场景在 3 个模型上跑通 | 1pd | ⏳ 2/3 已通过，Claude 中转待放行 |

**M1-27 证据**：`src/lib/engine/__tests__/m1-acceptance.test.ts` 按规格 §7 一一覆盖连续三次工具调用、畸形参数自纠、第二轮中断、`maxTurns`、无 tools Provider 降级、10MB 句柄化以及消费暂停 5 秒的背压，共 7 项全部通过。

**M1-28 证据**：Rust 共 15 项测试通过，其中 `sandbox.rs` 的 8 项覆盖规格要求的 7 个安全场景并额外覆盖安全创建嵌套路径；其余覆盖文件工具、快照 IO/隔离和工作区授权持久化。测试临时目录使用原子序号隔离，并行运行稳定。

**M1-29 状态（2026-08-13）**：三组真实凭据与中转配置均已就绪。DeepSeek `deepseek-v4-flash` 已完整执行 `list_dir`、`read_file` 和最终总结，终态为 `run.completed`，最近一次证据为 4216 input / 382 output / 4598 total tokens、3 turns、2 tool calls，并正确返回未知 marker。GPT `gpt-5.6-sol` 随后也完整通过相同流程，证据为 16111 input / 164 output / 16275 total tokens、3 turns、2 tool calls。Claude `claude-fable-5` 的标准 Anthropic Messages 请求仍不稳定：一次连接中转后收到 `403 Your request was blocked`，最近一次则在 HTTP 响应前连接失败，均未进入工具调用。因此不得将 Claude 记为通过，也不得以 mock 或其他兼容模型替代。

真实验收入口为 `npm run test:m1-live`。该命令自动读取存在的 `.env.m1-live.local`，并强制校验 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`，任一缺失即失败；也可由 shell 环境提供变量。`M1_CLAUDE_MODEL`、`M1_GPT_MODEL`、`M1_DEEPSEEK_MODEL` 和对应 `M1_*_BASE_URL` 可覆盖默认模型与 endpoint。每个模型都会在独立真实临时目录执行 `list_dir(".") → read_file("largest.md") → 总结文件内未知 marker`，校验工具顺序、参数、成功结果、终态及 token usage，并输出不含凭据的结构化证据。普通 `npm run test:run` 明确跳过该联网 suite。

**当前质量门禁（2026-08-13）**：前端 22 个测试文件、170 项测试全部通过，M1-29 live suite 在普通门禁中明确跳过；ESLint、TypeScript + Vite 生产构建、Rust fmt、Rust 应用构建、Rust 15 项测试与 `git diff --check` 通过。`target/debug/solidify` Mach-O 应用进程完成启动烟测并已正常清理。生产构建仍有既有 Tailwind 选择器与 Anthropic SDK browser externalization 警告，不影响退出状态。

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
- [x] `flags.agentLoop = false` 时，应用行为与改造前完全一致
- [x] [agent-loop.md §7](../specs/agent-loop.md) 的 7 个用例全部通过
- [x] 沙箱 7 个强制用例全部通过
- [x] 一次运行的 token 用量可在 UI 上看到
