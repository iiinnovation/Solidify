# Agent Runtime 分阶段工作流重构方案

> 状态：控制流模块化已实施（2026-08-25）；真实 Provider 发布矩阵仍待执行
>
> 范围：`src/lib/engine/`、`src/lib/tools/`、Artifact 交付合约、Harness 账本与相关测试
>
> 不包含：更换模型、禁止模型思考、引入 LangGraph 等外部运行时、重写 UI、重写 Provider Adapter

2026-09-10 恢复缺口修复：用户台账暴露 `compact_recovery` 未精简 inline 附件的问题。现已增加来源绑定的累计附件摘录预算、实际精简统计，以及续写/格式修复时的输入保持；原附件本地复放从 24,378 降为 5,313 个附件 token 估算值，112 个标题保留。304 项相关测试通过，真实 `deepseek-flash` 出图仍待复测，不能据此将真实 Provider 发布矩阵标为完成。详见 [修复记录](drawio-inline-recovery.md)。

## 1. 执行摘要

当前问题不是 `while (turn < maxTurns)` 形式的 Agent Loop 本身。单 Agent 循环仍适合开放式、步骤数量不可预知的任务，并且是 Solidify 中断、权限、工具回灌与流式事件的稳定执行基础。

真正的问题是：固定交付流程与开放 Agent 循环目前共用同一段大型控制逻辑，阶段状态通过 `drawioRun`、`forceDrawioGenerationOnly`、`closedToolGroups`、`activeTools` 等局部变量隐式表达。随着 Draw.io、PPTD、附件检索、产物校验和模型恢复不断加入，通用 Runtime 开始直接理解具体 Skill 和产物格式，扩展边界失守。

本方案采用混合架构：

- 普通问答走 `direct`，一次模型调用，无工具；
- 开放式任务保留 `agent`，继续使用有界 Agent Loop；
- 具有固定交付阶段的任务走 `staged-delivery`，由代码显式推进 `retrieval → generation → validation → repair`；
- 每个阶段通过 `CapabilityPolicy` 生成唯一的模型可见工具集合；
- 每类结构化产物通过 `DeliverableContract` 注册校验与修复规则；
- `query.ts` 不再直接识别 Draw.io、PPTD、Qwen 或具体工具名称。

这是一次 **中大型、核心路径、高回归风险但可渐进迁移的重构**，不是推倒重写。建议由本次撤销 PR 加后续 5 个可独立回滚的 PR 完成，总工作量约 **10–15 人日**；加上真实 Provider 验证和灰度观察，日历时间建议预留 **2–3 周**。

## 2. 已确认的现状

### 2.1 已经正确的能力

以下能力应保留，而不是重写：

- `runQuery()` 的 async-generator 事件流、背压和中断语义；
- Provider 统一流式接口及 OpenAI/Anthropic 消息转换；
- Tool Registry 的平台、Skill 白名单、附件与用户禁用过滤；
- 普通会话工具为 `[]` 的运行级能力收口；
- `ToolLoopGuard` 的结果签名、重复检测、预算与熔断；
- 工具结果回灌、权限、快照、运行账本和用量上限；
- 上下文编译、工具结果去重和大结果句柄化。

### 2.2 需要治理的结构性问题

| 问题 | 当前表现 | 影响 |
|---|---|---|
| 阶段隐式化 | 多个布尔值和集合共同决定下一轮行为 | 状态组合难以穷举，恢复路径容易重新开放工具 |
| Runtime 感知业务 | `query.ts` 识别 Draw.io、PPTD 和具体工具名 | 新格式继续增加分支，通用循环不可复用 |
| 工具能力有多个事实源 | 初始 Registry、`activeTools`、关闭组和业务特例共同过滤 | 同一阶段的实际工具集合难以证明 |
| 产物合约分散 | Draw.io 校验在 Runtime，其他 Artifact 在 UI/PPTD 管线 | 校验、错误展示和修复行为不一致 |
| 上下文职责分裂 | 附件路由在 Hook，上下文统计在 Compiler | 容易出现路由窗口与实际窗口不一致 |
| 观测不可验证 | token 插槽重叠统计，Ledger 丢失部分请求策略 | 日志容易导致错误诊断 |
| 真实评测不足 | Mock 覆盖循环，但缺少 Qwen + 大附件交付基准 | 单测通过不代表真实耗时和产物质量通过 |

### 2.3 不采用的诊断

- 不认为所有现代 Agent 都必须改成固定状态机；
- 不认为单一 `while` loop 天然错误；
- 不认为当前所有会话仍全量挂载工具；
- 不用 Prompt 文案替代能力隔离，但也不删除 LoopGuard；
- 不承诺未经测量的 90% 或 95% Prompt Cache 命中率；
- 不通过关闭模型思考来解决 Runtime 控制问题。

## 3. 设计目标与非目标

### 3.1 目标

1. 每次运行在调用模型前得到一个明确、可记录、可恢复的 `RunPlan`。
2. 每次 Provider 请求的工具集合只能来自当前阶段的 `CapabilityLease`。
3. 阶段退出后，过期能力不能因为恢复、重试或工具激活而重新出现。
4. Runtime 只理解运行模式、阶段、能力和合约，不理解具体产物名称。
5. 结构化产物统一执行确定性校验和有界修复。
6. 普通聊天和开放式 Agent 的行为保持兼容。
7. 运行账本能回答“在哪个阶段、暴露了哪些能力、为何转换、耗时在哪里”。

### 3.2 非目标

1. 不引入新的图编排框架或 DSL。
2. 不把每个 Skill 都拆成多 Agent。
3. 不要求生成阶段一律 `tools=[]`；由合约声明最小能力。
4. 不在本次改造中重写附件解析、PPTD 引擎或 Artifact 渲染器。
5. 不改变用户选择 Skill、上传附件和停止运行的交互语义。
6. 不把模型内部 reasoning 作为可持久化数据。

## 4. 目标运行模型

### 4.1 三种运行模式

```ts
export type RunMode =
  | 'direct'
  | 'agent'
  | 'staged-delivery'

export type RunPhase =
  | 'preparing'
  | 'retrieving'
  | 'generating'
  | 'validating'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'exhausted'
```

| 模式 | 适用任务 | 控制权 |
|---|---|---|
| `direct` | 普通问答、附件已内联且无结构化合约 | 单次模型调用 |
| `agent` | 编码、文件操作、开放检索、步骤数量未知 | 模型在有界 Loop 中决定工具 |
| `staged-delivery` | Draw.io、结构化文档等固定交付流程 | 代码决定阶段，模型只在阶段内决策 |

### 4.2 运行计划

`RunPlan` 在执行前由本地确定性代码创建，不增加一次路由模型调用：

```ts
export interface RunPlan {
  readonly mode: RunMode
  readonly initialPhase: RunPhase
  readonly contractId?: string
  readonly attachmentMode?: 'none' | 'inline' | 'retrieval'
  readonly maxRepairAttempts: number
  readonly reason: string
}
```

计划来源按优先级合并：

1. 用户明确选择的 Skill；
2. 本地高置信度 Skill 路由；
3. Skill/插件声明的 `deliverable` 元数据；
4. 附件路由结果；
5. 默认回落到 `direct` 或 `agent`。

`RoutePhase` 不应默认成为一次 LLM 调用。只有无法可靠分类且确实需要自动发现时，才允许进入现有的 Skill 激活机制。

### 4.3 分阶段交付流程

```text
preparing
    │
    ├── attachmentMode != retrieval ──────────────┐
    │                                             ▼
    └── attachmentMode == retrieval → retrieving → generating
                                                   │
                                                   ▼
                                               validating
                                                   │
                              valid ───────────────┴── invalid
                                │                         │
                                ▼                         ▼
                            completed               repairing
                                                          │
                                                          └── validating
```

确定性转换规则：

- `retrieving` 只暴露证据获取能力；模型停止调用工具、证据满足条件或预算到达时进入 `generating`；
- `generating` 使用合约声明的最小工具集；Draw.io 初始实现为 `[]`；
- `validating` 不调用模型，只运行本地 Validator；
- `repairing` 使用合约提供的精简修复输入和工具集，默认 `[]`；
- 修复达到上限后进入 `failed`，绝不回退到 `retrieving`；
- 所有模式仍受全局 turn、token、tool call、timeout 与 abort 限制。

## 5. 核心抽象

### 5.1 CapabilityPolicy 与 CapabilityLease

```ts
export interface CapabilityPolicyContext {
  readonly plan: RunPlan
  readonly phase: RunPhase
  readonly skill?: LoadedSkill
  readonly attachments: readonly AttachmentResource[]
  readonly closedGroups: ReadonlySet<string>
  readonly platform: 'web' | 'tauri'
}

export interface CapabilityLease {
  readonly phase: RunPhase
  readonly tools: readonly Tool[]
  readonly toolChoice: 'auto' | 'none'
  readonly allowedGroups: ReadonlySet<string>
  readonly fingerprint: string
}

export interface CapabilityPolicy {
  resolve(ctx: CapabilityPolicyContext): CapabilityLease
}
```

约束：

- `CapabilityLease` 是一次 Provider 调用工具面的唯一事实源；
- Tool Registry 负责“有哪些工具可用”，Policy 负责“本阶段允许哪些工具”；
- `executeTools()` 必须使用本轮 Lease 再校验，不能只相信模型返回的工具名；
- 阶段转换后重新解析 Lease，旧 Lease 不可复用；
- `ToolLoopGuard` 可以关闭能力组，但不能自行决定业务阶段；Workflow 根据关闭事实推进阶段；
- 工具激活不得突破当前阶段允许的 group。

### 5.2 DeliverableContract

```ts
export interface ValidationIssue {
  readonly code: string
  readonly message: string
  readonly path?: string
}

export type ValidationResult<TArtifact = unknown> =
  | { readonly valid: true; readonly artifact: TArtifact; readonly normalizedText?: string }
  | { readonly valid: false; readonly issues: readonly ValidationIssue[] }

export interface DeliverableContract<TArtifact = unknown> {
  readonly id: string
  readonly version: string
  readonly generationCapabilities: readonly string[]
  readonly repairCapabilities: readonly string[]
  readonly maxRepairAttempts: number

  validate(text: string): ValidationResult<TArtifact>
  buildRepairMessages(input: {
    originalTask: Message
    invalidOutput: string
    issues: readonly ValidationIssue[]
    attempt: number
  }): readonly Message[]
}
```

边界：

- 合约只定义产物解析、校验、修复输入和阶段能力，不执行 Provider 请求；
- 合约由可信代码注册，普通 `SKILL.md` 不能注入可执行 Validator；
- Skill 元数据只引用 `contractId`；未知合约必须安全回落或明确失败；
- 合约版本进入缓存 fingerprint、快照和账本；
- 修复输入必须包含校验错误和必要的无效输出，不能只写“重试”；
- 大型无效输出需要受预算控制，必要时存入本地句柄，但 Repair 阶段不能重新开放检索工具。

### 5.3 PhaseController

```ts
export interface PhaseState {
  readonly phase: RunPhase
  readonly turn: number
  readonly repairAttempts: number
  readonly evidenceComplete: boolean
  readonly closedGroups: ReadonlySet<string>
}

export interface PhaseTransition {
  readonly from: RunPhase
  readonly to: RunPhase
  readonly reason: string
}
```

`PhaseController` 只做确定性状态转换，不读取具体 Skill 名称。每次转换产出稳定领域事件，写入实时总线与 Ledger。

## 6. 模块落点

建议保持 `runQuery()` 对 UI 的公开接口不变，内部逐步拆分：

```text
src/lib/engine/
├── query.ts                       兼容入口，最终收敛为运行协调器
├── run-plan.ts                    创建 direct / agent / staged-delivery 计划
├── phase-controller.ts            阶段状态与转换规则
├── capability-policy.ts           解析每阶段 CapabilityLease
├── agent-loop.ts                  开放式 Agent Loop
├── loop-runtime.ts                两类入口共享的有界传输、工具执行与账本骨架
├── staged-delivery.ts             固定交付工作流
├── recovery.ts                    通用 max-token / compact recovery
└── deliverables/
    ├── types.ts                   DeliverableContract 接口
    ├── registry.ts                合约注册与解析
    ├── text.ts                    默认纯文本合约
    └── drawio.ts                  Draw.io 解析、校验和修复消息
```

PPTD 当前拥有独立确定性生成管线，第一阶段只接入统一合约与事件，不强行迁移其生成器。待 Draw.io 路径稳定后，再判断是否把 PPTD 的外层控制流纳入 `staged-delivery`。

## 7. 上下文与 Prompt Cache

目标不是承诺某个缓存命中率，而是建立可测量的不变量：

1. 同一阶段内 system、Skill、合约版本和工具 Schema 保持稳定；
2. 动态时间、用户输入、附件正文和工具结果位于稳定前缀之后；
3. 阶段转换允许 fingerprint 改变，但同阶段不得因无关状态抖动；
4. fingerprint 必须包含 `mode + phase + contractId/version + lease fingerprint`；
5. Ledger 记录 Provider 实际返回的 cache read/write token；
6. 只有真实模型基准显示收益后，才把缓存命中率写入验收指标。

附件策略保持为显式输入：

- `inline`：正文已在当前任务消息中，直接生成；
- `retrieval`：进入检索阶段，证据完成后生成；
- Context Compiler 负责最终预算裁剪和互斥 token 统计；
- UI Hook 只负责资源准备，不再拥有最终模型上下文决策。

## 8. 可观测性与恢复

### 8.1 新增稳定事件

```text
run.planned
phase.started
capability.bound
phase.completed
phase.transitioned
deliverable.validated
deliverable.repairing
```

最小账本字段：

- `mode`、`phase`、`contractId/version`；
- 工具名称或能力组、`toolChoice`、Lease fingerprint；
- 转换原因、阶段内 turn/tool/token 用量；
- 请求就绪、首 chunk、模型完成三个时刻；
- 互斥的上下文 token 槽位及总计；
- 校验 issue code，不保存完整产物或隐藏思维链；
- Provider 返回的 cache read/write token。

### 8.2 快照兼容

新快照增加可选字段：

```ts
interface WorkflowSnapshotV2 {
  version: 2
  plan: RunPlan
  phaseState: PhaseState
  contractVersion?: string
  messages: readonly Message[]
  usage: UsageStats
}
```

- V1 快照继续按旧 Agent Loop 恢复；
- V2 恢复时重新解析 Lease，禁止序列化工具实例；
- 合约版本不匹配时停止自动恢复并给出可解释错误；
- Repair 快照恢复后不得回到 Retrieval。

## 9. 分阶段实施计划

### PR-0：撤销模型专属思考禁用（0.5pd）

- 删除 `reasoningMode`、`/no_think`、`enable_thinking` 和相关 Relay 字段；
- 保留工具收口、统一上下文窗口和有界恢复；
- 验证 Qwen 请求不再被 Runtime 强制修改思考策略。

### PR-1：观测校准与行为基线（1.5–2pd）

- 修复附件 token 重复统计，使槽位互斥且总和可解释；
- Ledger 保留 `toolChoice`、运行模式、阶段和 capability fingerprint；
- 补齐单轮 ready/first-chunk/completed 时序；
- 增加 Qwen + 77.6KB 附件的真实基准夹具和结果格式；
- 固化改造前的完成率、工具次数、Provider 调用次数、TTFT 和总耗时。

### PR-2：引入抽象但不改变行为（2–3pd）

- 新增 `RunPlan`、`PhaseState`、`CapabilityLease` 和 `DeliverableContract` 类型；
- 实现 Registry 与默认文本合约；
- 让现有 `runQuery()` 通过适配器读取 Lease，但维持原有执行顺序；
- 建立“模型请求工具集等于 Lease 工具集”的断言与测试；
- 新增 `stagedRuntime` 特性开关，默认关闭。

### PR-3：Draw.io 迁移到 staged-delivery（3–4pd）

- 将 Draw.io Validator 和修复消息移入 `deliverables/drawio.ts`；
- 实现检索、生成、校验、单次修复的显式转换；
- 生成与修复阶段工具物理为空；
- 从 `query.ts` 删除 Draw.io 名称判断和相关常量；
- 对同一输入执行旧路径与新路径回归对比；
- 灰度开启 `stagedRuntime`，保留一版快速回退能力。

### PR-4：通用化与旧分支退役（2–3pd）

- 将通用 max-token recovery 从 Draw.io 条件分支移入阶段恢复策略；
- 收敛 `activeTools`、`closedToolGroups` 和 Tool Registry 的事实源；
- 接入通用 Artifact 解析事件；
- 评估 PPTD 外层合约接入，暂不改写内部生成管线；
- 删除被合约替代的旧分支、Prompt 劝阻与占位符结果。

### PR-5：全量验证与文档收口（1–2pd）

- Provider 矩阵：OpenAI、Anthropic、内网 Qwen/OpenAI-compatible；
- 任务矩阵：普通聊天、附件内联、附件检索、开放工具、Draw.io 成功/失败/修复/中断；
- 更新 Agent Loop 规格、ADR 和运行账本说明；
- 达到验收门槛后默认开启新路径，并在后续版本移除开关。

## 10. 测试策略与验收门槛

### 10.1 单元与性质测试

- 每个 `mode × phase` 的 Lease 快照；
- 已关闭 group 在所有后续阶段不可重新出现；
- 模型返回不在 Lease 中的工具时不得执行；
- Repair 次数永远不超过合约上限；
- Repair 不能转回 Retrieval；
- 未注册合约安全失败；
- V1/V2 快照恢复兼容；
- abort 在所有阶段都产生唯一终态；
- Ledger 每个 run 只有一个终态事实。

### 10.2 集成测试

| 场景 | 期望 |
|---|---|
| 普通 `hi` | `direct`、工具 0、模型 1 次 |
| 已内联附件 + Draw.io | 跳过检索，生成工具 0 |
| 检索附件 + Draw.io | 检索工具有界；进入生成后工具 0 |
| Draw.io 无 Artifact | 校验失败；修复 1 次；不重新检索 |
| Draw.io 修复仍失败 | 明确失败，停止运行 |
| 开放文件任务 | 保持 Agent Loop 与权限确认行为 |
| 推理耗尽输出窗口 | 通用 compact recovery 最多 1 次，不改变能力边界 |
| 用户停止 | 当前请求取消，无后续阶段启动 |

### 10.3 真实模型门槛

不以 Mock 测试代替真实 Provider 验证。至少记录：

- 成功完成率；
- Artifact 首次校验通过率和修复后通过率；
- Provider 调用次数、工具调用次数；
- 每阶段 TTFT、持续时间、input/output/cache token；
- 重复检索率和阶段回退次数；
- 普通聊天相对基线的延迟变化。

发布门槛：

- 普通聊天与开放 Agent 无功能回归；
- 新路径不存在生成后重新检索；
- 所有失败在限制内结束；
- Draw.io 完成率不低于旧路径；
- Provider 调用次数和总耗时以真实数据报告，不预设夸大目标。

## 11. 风险与控制

| 风险 | 级别 | 控制措施 |
|---|---|---|
| 核心循环回归 | 高 | 保持公开事件接口；特性开关；逐合同迁移 |
| Provider 对历史 tool message 兼容不同 | 高 | OpenAI/Anthropic/内网网关分别做集成测试 |
| 状态和快照不一致 | 中高 | PhaseState 单一事实源；版本化快照；恢复性质测试 |
| 工具裁剪过度导致任务不能完成 | 中 | 合约声明最小能力；Lease 快照评审；明确失败而非静默降级 |
| Artifact 修复输入过大 | 中 | 输出预算、局部错误、必要时本地句柄化 |
| Prompt Cache 误判 | 中 | 记录真实 cache token，不用估算命中率做结论 |
| PPTD 被过早统一 | 中高 | 第一阶段只接统一合约和事件，保留内部专用管线 |
| 自定义 Skill 无合约 | 低 | 默认 `text`/开放 Agent 路径，不要求迁移全部 Skill |

## 12. 规模评估

### 12.1 为什么是中大型而不是大型重写

不重写的部分占 Runtime 的大多数基础能力：Provider、Tool Executor、权限、Ledger 存储、消息格式、中断、快照载体和 UI 消费协议都继续使用。

需要重构的是控制层和扩展边界：

- 预计新增或拆分 6–9 个小模块；
- 预计修改 12–18 个生产文件、8–12 个测试文件；
- 预计新增/迁移约 1,200–2,000 行代码与测试；
- `query.ts` 应净减少业务分支，而不是继续增长；
- 一名熟悉代码的工程师约 10–15pd；
- 若包含真实网关环境排队、灰度观察和问题修复，安排 2–3 周更稳妥。

### 12.2 可以安全停下的检查点

- 完成 PR-1 后：日志可信，即使暂不重构也有独立价值；
- 完成 PR-2 后：只有抽象层，开关关闭时行为不变；
- 完成 PR-3 后：只迁移 Draw.io，可独立判断收益；
- 完成 PR-4 后：通用 Runtime 才真正完成去业务化；
- 任一阶段指标退化都可以关闭新路径，不需要回滚整个 Runtime。

## 13. 架构完成定义

只有同时满足以下条件，才能称为改造完成：

1. `query.ts` 不再包含 `drawio-diagram`、PPTD 产物格式或模型名称判断；
2. 每次模型调用都能从 Ledger 还原其 `mode / phase / capability fingerprint`；
3. Provider 请求中的工具严格等于当前 Lease；
4. 结构化产物统一走 Contract 校验与有界修复；
5. 普通问答、开放 Agent 和固定交付 Workflow 三条路径都有真实模型回归；
6. 新架构的收益来自可重复测量，而不是 Prompt 文案或单次截图。

## 14. 参考原则

- [Anthropic · Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：固定、可分解任务采用 Workflow；开放任务采用 Agent；优先简单、可组合设计。
- [OpenAI · A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)：保留有退出条件的 Agent Loop，按当前状态选择适当工具，并以评测驱动复杂度增长。
- [LangChain Agents](https://docs.langchain.com/oss/python/langchain/agents)：支持静态与动态工具选择，确定性 Guardrail 应在 Agent Loop 外执行。
- [OpenHands architecture](https://github.com/AI-App/All-Hands-AI.OpenHands/blob/main/openhands/README.md)：状态、Action、Observation 与 Runtime 围绕有界循环协作。
