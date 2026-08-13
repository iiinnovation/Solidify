# 02 · 目标架构

## 1. 分层总览

采用 [reference/core_architecture_overview.md](reference/core_architecture_overview.md) 的五层体系，映射到 Solidify 的技术栈：

```
┌──────────────────────────────────────────────────────────────┐
│  UI 层   React 19 · 三栏工作台 · Artifact 渲染器族             │
├──────────────────────────────────────────────────────────────┤
│  L4  扩展层        Skill 加载器 / 插件 / 特性开关               │
├──────────────────────────────────────────────────────────────┤
│  L3  Harness      Hook 系统 · 权限策略 · 运行账本 · 可观测      │
├──────────────────────────────────────────────────────────────┤
│  L1  交互引擎      QueryEngine · 异步生成器管线 · 中断恢复       │
│  L2  工具系统      Tool 接口 · 注册表 · 执行调度                │
├──────────────────────────────────────────────────────────────┤
│  L5  记忆与状态    memdir · 工作区索引 · 向量检索 · 会话快照      │
├──────────────────────────────────────────────────────────────┤
│  能力层  Tauri Rust: 文件系统 · 监听 · SQLite · 进程 · 沙箱      │
└──────────────────────────────────────────────────────────────┘
                            ↕ 可选
              Supabase: 账号 · 同步 · 托管模型代理
```

L1 和 L2 画在同一格，因为它们是**同一个循环的两半** —— 引擎决定调什么工具，工具的结果回灌引擎。分开实现但必须一起设计。

## 2. 四支柱 → 五层映射

| 产品支柱 | 主要落在 | 依赖 |
|---|---|---|
| 文件管理 | 能力层 + L5 | Rust fs/watch/sqlite |
| 项目作业区 | L5 + UI | 工作区格式 + 状态快照 |
| Skills | L4 | L2 工具白名单、L5 按需加载 |
| Agent 协作 | L1 + L2 + L3 | 全部 |

可以看出：**L1/L2 是所有支柱的公共依赖**。这是 M1 排第一的结构性原因，不是偏好。

## 3. 各层职责与落点

### L1 · AI 交互引擎（"大脑"）

把 `use-chat.ts` 里的单次请求，升级为可循环、可中断、可恢复的查询引擎。

```
src/lib/engine/
├── query-engine.ts     会话容器：打包 cwd/记忆/工具/权限为不可变上下文
├── query-loop.ts       核心循环：async generator，产出 QueryEvent 流
├── model-gateway.ts    模型接入：统一 openai/anthropic 两种 wire format
├── stream-parser.ts    SSE 解析：文本增量 + tool_use 增量
└── tombstone.ts        异常消息墓碑化，不崩会话
```

四条工程原则（来自参考架构，必须遵守）：

1. **异步生成器 + 背压** —— 由消费端（UI）驱动管线推进，模型快速输出时不会内存堆积
2. **Tombstoning** —— 孤儿消息、格式错误的工具调用产出墓碑事件而非抛错，UI 可透明隐藏，会话不中断
3. **资源自动清理** —— 循环中的预取、网络调用绑定显式清理，Ctrl+C / 用户中断时不泄漏
4. **不可变上下文** —— 每轮循环构造新的 `ToolUseContext`，避免竞态

详见 [specs/agent-loop.md](specs/agent-loop.md)。

### L2 · 工具系统（"四肢"）

```
src/lib/tools/
├── types.ts            Tool / ToolUseContext / ToolResult 接口
├── registry.ts         注册表：注册、查找、生成模型可见的 schema
├── executor.ts         执行调度：校验 → 权限 → 执行 → 结果规范化
└── builtin/
    ├── read-file.ts
    ├── write-file.ts
    ├── list-dir.ts
    ├── search-files.ts
    ├── capture-preview.ts
    └── web-search.ts
```

每个工具必须声明：输入/输出 Schema、是否只读、是否可并发、是否具破坏性、是否需要人工确认、所需权限范围、超时与重试策略。

详见 [specs/tool-interface.md](specs/tool-interface.md)。

### L3 · Harness（"护甲"）

参考架构里最复杂也最可复用的一层。职责是**让 Agent 不做危险的事，并且做过什么都留得下痕**。

```
src/lib/harness/
├── hooks.ts            HookManager：before_tool_call / after_tool_call / on_error / on_settings_change
├── policy.ts           权限策略引擎，结果统一为 allow | ask | deny
├── flags.ts            特性开关，未完成能力默认关闭
├── ledger.ts           运行账本：追加式事件流
└── telemetry.ts        耗时、token、错误统计
```

**权限结果三态**是整个安全模型的基石：

- `allow` — 允许执行并记录原因
- `ask` — 暂停循环，等待用户确认（这就是「人在环」的实现点）
- `deny` — 拒绝并返回可解释原因给模型，模型可换路径

策略来源按优先级合并：`会话临时授权 > 用户设置 > 项目策略 > 全局默认`。

**运行账本**是与聊天记录并列的第二条真相线。聊天消息是给人看的，账本是给审计和回溯用的：

```
run.started → tool.requested → permission.required → permission.resolved
→ tool.completed → artifact.created → run.completed
```

详见 [specs/harness.md](specs/harness.md)。

### L4 · 扩展层

```
src/lib/skills/
├── loader.ts           扫描工作区与用户目录，解析 SKILL.md frontmatter
├── registry.ts         Skill 索引，只把 name+description 注入初始上下文
└── resources.ts        reference/ examples/ assets/ 的按需读取
```

核心机制是**渐进式披露**：初始上下文只有各 Skill 的一行描述（全部加起来几百 token），模型判断相关后才通过 `read_file` 拉取详细规范。这是让「一份 2000 行的格式规范」可用而不炸上下文的唯一办法。

详见 [specs/skill-format.md](specs/skill-format.md)。

### L5 · 记忆与状态

分三个时间尺度：

| 尺度 | 载体 | 内容 |
|---|---|---|
| 会话内 | `memdir`（内存 Map） | 本轮相关片段、工具大结果的句柄 |
| 项目内 | SQLite（`.solidify/index.db`） | 文件索引、全文检索、向量、会话快照 |
| 跨项目 | Supabase（可选） | 模板库、跨设备同步的知识条目 |

两条重要约束：

- **工具的大结果不进模型上下文**。落入受控存储，只把摘要 + 句柄给模型，模型需要细节时再取。
- **按需构建最小上下文**，不默认加载整个项目。

详见 [reference/memory_state_management.md](reference/memory_state_management.md) 与 [specs/workspace-format.md](specs/workspace-format.md)。

### 能力层 · Tauri Rust

从 31 行长到约 1.5k–2k 行，提供 L2 工具真正需要的原语：

| Command | 说明 | 现状 |
|---|---|---|
| `list_dir` / `read_tree` | 目录遍历，带 gitignore 风格过滤 | 需新增（插件只有单文件读写） |
| `watch_dir` | `notify` crate，变更 emit 事件到前端 | 需新增 |
| `db_*` | SQLite（rusqlite 或 tauri-plugin-sql） | 需新增 |
| `run_process` | 白名单进程执行 | 需新增 |
| `resolve_in_workspace` | **路径沙箱校验** | 需新增，安全关键 |
| 文件读写、对话框、通知 | | 已有（`lib/tauri.ts`） |

⚠️ `resolve_in_workspace` 是安全底线。一旦 Agent 有了写文件能力，路径越界就是事故。所有 fs 类 command 必须先过它，且校验在 **Rust 侧**做，不能只在 TS 侧做（TS 侧可被绕过）。

## 4. 数据分层与本地优先

```
本地（真相源）                        Supabase（同步/协作层，可选）
──────────────────────                ────────────────────────────
项目目录 = 作业区                       账号与授权
  用户文件（原始材料、交付物）             团队共享的项目快照（元数据）
  .solidify/conversations/*.jsonl       模板库
  .solidify/artifacts/ 版本             跨设备知识条目
  .solidify/ledger/ 运行账本             用量统计
  .solidify/index.db 索引与向量          托管模型代理（不自带 key 的用户）
用户 API Key（系统密钥环）
```

迁移原则：

- **新建项目直接本地优先**，不做双向长期同步
- 老项目提供一次性「导出到本地工作区」
- Supabase 表结构基本保留，语义从「主库」变为「快照与共享」
- 应用在**完全没有 Supabase 的情况下必须能跑**（自带 API Key 模式）

## 5. 一次完整交办的数据流

以「读三份纪要 → 出需求文档 → 出 PPT」为例：

```
用户输入 + 选中 Skill
    ↓
QueryEngine 构建 ToolUseContext（cwd=项目目录, tools=白名单, permissions, memory）
    ↓
┌─→ ModelGateway 调用模型（messages + tools schema）
│       ↓
│   模型返回 tool_use: read_file("01-输入材料/访谈纪要-A.md")
│       ↓
│   Harness: before_tool_call hook → PolicyEngine → allow（只读，白名单内）
│       ↓
│   ToolExecutor → Rust list_dir/read_file → 沙箱校验通过 → 内容
│       ↓
│   大结果入 memdir，摘要+句柄回灌 messages；账本记 tool.completed
│       ↓
└───── 循环（重复 N 次：读文件 → 读 Skill 规范 → 写文档 → 渲染 → 截图自检 → 修正）
        ↓
    模型返回 tool_use: write_file("03-交付物/需求规格.md")
        ↓
    PolicyEngine → ask（破坏性写操作）→ 循环暂停 → UI 弹确认 → 用户批准
        ↓
    写盘 + artifact.created 事件 + 版本落 .solidify/artifacts/
        ↓
    模型无更多工具调用 → 产出最终消息 → run.completed
```

关键点：**循环在 `ask` 处真正暂停**（generator 挂起），不是异步弹窗后继续跑。这是人在环的语义正确性要求。

## 6. 目录规划总览

```
src/
├── lib/
│   ├── engine/          L1  新增
│   ├── tools/           L2  新增
│   ├── harness/         L3  新增
│   ├── skills/          L4  新增（现 skills.ts 内容迁出为数据）
│   ├── memory/          L5  新增
│   ├── workspace/       工作区读写与索引  新增
│   ├── pptd/            PPTD 引擎  新增（M5）
│   ├── rag/             保留，并入 L5
│   ├── api/             保留，语义降级为同步层
│   └── tauri.ts         保留，扩充
├── components/
│   ├── workspace/       文件树、项目视图  新增
│   ├── agent/           运行过程、工具调用、确认弹窗  新增
│   └── artifacts/       保留，新增 pptd-renderer
└── stores/              保留，新增 run-store / workspace-store

src-tauri/src/
├── fs/                  目录树、监听、沙箱  新增
├── db/                  SQLite  新增
├── process/             白名单进程  新增
└── lib.rs               注册 commands
```

## 7. 架构风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| Agent 循环在前端，关窗口即中断 | 长任务不可用 | M1 先做会话快照可恢复；真正的后台执行留到 L1 下沉 Rust（M6 后评估） |
| 路径沙箱漏洞 | 数据损毁 | 校验放 Rust 侧；写操作默认 `ask`；`specs/tool-interface.md` 定强制测试用例 |
| 上下文膨胀导致成本失控 | token 账单 | 大结果句柄化 + 渐进式披露 + 每轮上限 |
| 本地/云端双真相 | 数据打架 | 不做长期双向同步，只做单向快照 |
| 模型工具调用能力参差 | 部分模型不可用 | Model Gateway 声明能力位；不支持 tools 的模型降级为纯对话模式 |
