# spec · 工具接口

> 约束模块：`src/lib/tools/`　对应里程碑：[M1](../phases/M1-agent-runtime.md)
> 参考：[reference/core_tech_extraction.md](../reference/core_tech_extraction.md) §2

## 1. Tool 接口

```ts
export interface Tool<I = unknown, O = unknown> {
  /** 模型可见的名称，snake_case，全局唯一 */
  name: string

  /** 模型可见的描述。写清楚"什么时候用"，比"是什么"更重要 */
  description: string

  /** 输入 schema，执行前强制校验 */
  inputSchema: JSONSchema

  /** 输出 schema，可选，用于结果规范化 */
  outputSchema?: JSONSchema

  /** ── 行为声明，供 Harness 决策 ── */
  readOnly: boolean          // 只读工具可跳过确认、可并发
  concurrencySafe: boolean   // 是否可与其他工具并行执行
  destructive: boolean       // 是否可能造成不可逆后果
  requiresConfirmation: boolean | ((input: I, ctx: ToolUseContext) => boolean)

  /** ── 环境要求 ── */
  availability: ToolAvailability   // 'always' | 'tauri-only' | 'online-only'
  permissions: PermissionScope[]   // 需要的权限范围

  /** ── 执行策略 ── */
  timeoutMs?: number
  retry?: { maxAttempts: number; backoffMs: number }

  /** 执行 */
  execute(
    input: I,
    ctx: ToolUseContext,
    signal: AbortSignal,
    onProgress?: (p: ToolProgress) => void,
  ): Promise<ToolResult<O>>

  /** 生成给用户看的一行描述，用于确认弹窗与账本 */
  renderCall(input: I): string
}
```

`renderCall` 别省。确认弹窗上写「即将执行 write_file」和写「即将写入 `03-交付物/需求规格.md`（约 4200 字，将覆盖已有文件）」，用户的决策质量完全不同。

## 2. 执行上下文

```ts
/** 每轮循环重新构造，不可变 */
export interface ToolUseContext {
  readonly runId: string
  readonly cwd: string                    // 工作目录 = 项目根，沙箱边界
  readonly workspace: WorkspaceHandle
  readonly memory: MemoryState
  readonly settings: Readonly<Settings>
  readonly permissions: PermissionMap
  readonly platform: Platform
  readonly logger: RunLogger              // 写运行账本
}
```

**不可变是硬要求**。工具不得修改 ctx。需要传递状态就通过 `memory` 或返回值，不要在 ctx 上挂东西 —— 那会让并发执行产生竞态。

## 3. 结果

```ts
export interface ToolResult<T = unknown> {
  success: boolean

  /** 给模型看的内容。大结果必须句柄化，见 agent-loop.md §6 */
  content: string

  /** 结构化数据，给 UI 用 */
  data?: T

  /** 大结果的存储句柄 */
  handle?: string
  truncated?: boolean

  /** 失败时的可解释错误。要能让模型据此换方案，不是给人看的堆栈 */
  error?: {
    kind: 'invalid_input' | 'not_found' | 'permission_denied'
        | 'timeout' | 'aborted' | 'runtime'
    message: string
    recoverable: boolean
  }

  metadata?: {
    durationMs: number
    bytesRead?: number
    bytesWritten?: number
  }
}
```

错误信息写给模型看，例：

- ❌ `ENOENT: no such file or directory, open '/Users/x/p/a.md'`
- ✅ `文件 01-输入材料/a.md 不存在。该目录下现有文件：访谈纪要-A.md, 访谈纪要-B.md, 现状调研.docx`

第二种能让模型一轮就自纠。

## 4. 执行流程

```
模型产出 tool_use
    ↓
① 注册表查找工具 ────── 未找到 → tombstone + 回灌可用工具列表
    ↓
② 环境可用性检查 ────── 不可用 → error{kind:'permission_denied'}
    ↓
③ inputSchema 校验 ──── 不通过 → tombstone + 回灌校验错误
    ↓
④ Hook: before_tool_call
    ↓
⑤ PolicyEngine 判定 ─── deny → error{permission_denied}
    │                  ask  → 挂起循环，等用户确认
    ↓ allow
⑥ execute(input, ctx, signal, onProgress)
    ↓
⑦ 结果规范化 + 大结果句柄化
    ↓
⑧ Hook: after_tool_call
    ↓
⑨ 落账本 tool.completed
```

③ 必须在 ⑤ 之前：不能对一个参数都不合法的调用去问用户要授权。

## 5. 并发

同一轮模型可能返回多个 `tool_use`。执行规则：

```ts
// 全部 concurrencySafe && readOnly → 并行
// 否则 → 串行，按模型返回顺序
const canParallel = calls.every(c =>
  registry.get(c.name)?.concurrencySafe && registry.get(c.name)?.readOnly
)
```

保守策略。首版只让读类工具并行，写类一律串行。并发写文件的正确性问题不值得在 M1 处理。

## 6. 首批内置工具（M1 范围）

| 工具 | readOnly | 确认 | 环境 | 说明 |
|---|---|---|---|---|
| `list_dir` | ✅ | 否 | tauri-only | 列目录，支持 gitignore 风格过滤、深度限制 |
| `read_file` | ✅ | 否 | tauri-only | 读文本，支持 offset/limit；二进制返回元信息 |
| `write_file` | ❌ | **是** | tauri-only | 写文件，覆盖时在确认信息中明示 |
| `search_files` | ✅ | 否 | tauri-only | 内容检索（ripgrep 风格）与文件名匹配 |
| `capture_preview` | ✅ | 否 | always | 截取当前 artifact 渲染结果为图片，供视觉自检 |
| `web_search` | ✅ | 否 | online-only | 联网检索素材 |

`capture_preview` 是 M5 视觉自检回环的前提，M1 就要做 —— 见 [ADR-0003](../04-decisions.md#adr-0003)。

### 明确不做的工具

| 工具 | 原因 |
|---|---|
| `run_shell` / `exec` | 任意命令执行的权限模型无法收敛。需要执行外部程序时，注册**具体用途**的工具（如 `convert_document`），白名单可执行文件与参数 |
| `sql_query` | 首版没有此需求，且注入面大 |

## 7. 注册表

```ts
export interface ToolRegistry {
  register(tool: Tool): void

  /** 按运行环境 + Skill 白名单 + 用户设置过滤，返回本次可用工具 */
  resolve(ctx: ResolveContext): Tool[]

  /** 生成模型可见的 schema，按 wire format 适配 */
  toSchema(tools: Tool[], format: 'openai' | 'anthropic'): unknown[]
}
```

`resolve` 的三层过滤缺一不可：

1. **环境** —— Web 端没有 `tauri-only` 工具
2. **Skill 白名单** —— `SKILL.md` frontmatter 的 `allowed-tools`，未声明则用默认集
3. **用户设置** —— 用户可全局禁用某些工具

## 8. 路径沙箱

所有涉及路径的工具，进入 `execute` 前必须过：

```ts
// TS 侧：提前失败的优化
const resolved = resolveInWorkspace(input.path, ctx.cwd)

// Rust 侧：真正的安全边界（ADR-0005）
#[tauri::command]
fn read_file(path: String, workspace_root: String) -> Result<String, Error> {
    let safe = resolve_in_workspace(&path, &workspace_root)?;   // ← 边界在这
    fs::read_to_string(safe)
}
```

**强制测试用例**（缺一不允许合并）：

| # | 输入 | 期望 |
|---|---|---|
| 1 | `../../../etc/passwd` | 拒绝 |
| 2 | 指向工作区外的符号链接 | 拒绝（需 canonicalize 后再比较） |
| 3 | `/etc/passwd` 绝对路径 | 拒绝 |
| 4 | `\\?\C:\Windows\...` UNC | 拒绝 |
| 5 | 大小写不敏感文件系统上的 `.SOLIDIFY/` | 与 `.solidify/` 同等对待 |
| 6 | 工作区内的正常相对路径 | 允许 |
| 7 | 工作区内指向工作区内的符号链接 | 允许 |

## 9. MCP 预留

首版不实现 MCP，但接口要留出口子：Tool 接口本身与 MCP 的工具定义结构兼容，未来 MCP server 的工具可以包装成 `Tool` 注册进同一个注册表，不需要改动 L1/L3。

不要为此提前抽象。留意保持 `name / description / inputSchema / execute` 这四个字段的形状不偏离即可。
