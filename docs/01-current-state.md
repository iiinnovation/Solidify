# 01 · 现状盘点与差距分析

> 本文所有结论来自 2026-08-11 对代码的实际阅读，不是根据 README 或历史文档推断。所有引用给出 `文件:行号`。

## 1. 代码规模与技术栈

| 层 | 规模 | 技术栈 | 成熟度 |
|---|---|---|---|
| 前端 | **13,696 行** TS/TSX | React 19 + Vite + Tailwind 4 + zustand + TanStack Query + Radix | 成熟 |
| 桌面壳 | **31 行** Rust | Tauri 2.10 | 空壳 |
| 后端 | 340 行 Deno | Supabase Edge Functions | 单薄 |
| 数据库 | 9 张表 + 10 个迁移 | Postgres + pgvector + RLS | 扎实 |

前端模块分布：

```
src/lib          20 文件   核心逻辑（skills / export / rag / tauri / template-engine）
src/lib/api      10 文件   Supabase 数据访问
src/hooks         9 文件   业务 hook（use-chat 18KB 是最重的一个）
src/stores        8 文件   zustand 状态
src/routes        7 文件   页面（settings 23KB 最大）
src/components/artifacts  7 文件   渲染器（drawio-renderer 34KB 最大）
```

## 2. 逐层现状

### 2.1 桌面壳：空的

`src-tauri/src/lib.rs` 只有 22 行，`main.rs` 6 行，**没有任何自定义 command**。挂载的全是官方插件：

```
dialog / fs / os / notification / window-state / updater / process / log
```

`src/lib/tauri.ts` 做了一层封装（250 行），提供文件对话框、单文件读写、通知、更新检查，Web 端自动降级为 no-op。设计是对的，但能力集只覆盖到「弹个框存文件」。

**缺失**：目录树遍历、文件变更监听、进程执行、本地数据库、路径沙箱校验。

> 判断：Tauri 目前只是个打包壳，不是运行时。所有需要真正「本地能力」的功能都要从这里补。

### 2.2 AI 调用：纯转发代理，无工具调用

`supabase/functions/chat/index.ts` 全文 177 行，本质是：

```
校验 auth → 拼 system prompt → streamChat() → 把上游 SSE body 原样透传
```

`_shared/ai-providers.ts:76` 的 `streamChat` 和 `:122` 的 `streamChatCustom` 都只发送 `{model, messages, stream: true}`。

**没有 `tools` 参数。没有 `tool_use` 解析。没有多轮循环。** 一次请求进，一段 SSE 出，结束。

一个有价值的发现：`streamChatCustom` 允许前端传入完整的 `apiUrl / apiKey / modelId / format`（`ai-providers.ts:122-160`），说明**前端直连模型的通路已经打通**。这让 Edge Function 可以从「必经之路」平滑降级为「可选代理」，本地优先改造不用推倒重来。

支持的模型：DeepSeek（chat / reasoner）、Claude（sonnet-4 / haiku-4）、GPT（4o / 4o-mini），两种 wire format（openai / anthropic）。

### 2.3 Artifact：正则从流里抠标签

产生机制在 `src/hooks/use-chat.ts:45`：

```js
/<solidify-artifact\s+title="([^"]+)"\s+type="([^"]+)">([\s\S]*?)<\/solidify-artifact>/g
```

`use-chat.ts:60` 另有一条未闭合版本的正则，用于流式传输中途的增量渲染。整体实现是完整的（流中开始 → 增量更新 → 闭合定稿 → 流中断兜底），工程质量不错。

类型共 6 种（`src/lib/api/types.ts:62`）：`document | slides | code | mermaid | chart | drawio`

**局限**：
- 靠模型输出格式良好的标签，模型跑偏就丢 artifact，无结构化保证
- `version` 字段存在但没有版本树，只是个递增数字
- artifact 存 Supabase `content TEXT`，没有落到本地文件

### 2.4 Skill：10 个 prompt 字符串

`src/lib/skills.ts` 21KB，数据结构是：

```ts
interface Skill {
  id, name, description, icon, placeholder,
  skipConfirmation: boolean,
  systemPrompt: string,      // ← 全部内容都在这
  recommendedModels?: string[]
}
```

内置 10 个：

| id | 名称 |
|---|---|
| requirement-analysis | 需求分析 |
| solution-design | 方案设计 |
| demo-code | 演示代码 |
| gap-analysis | 差距分析 |
| test-plan | 测试方案 |
| meeting-notes | 会议纪要 |
| report-outline | 汇报大纲 |
| glossary | 术语解释 |
| presentation | 演示文稿 |
| drawio-diagram | Draw.io 流程图 |

自定义 Skill 存在 **localStorage**（`src/stores/skill-store.ts`，zustand persist，key = `solidify-custom-skills`）。

**局限**：没有文件资源、没有可执行部分、没有工具绑定、没有版本、没有导入导出、清缓存就没了。与业界 Skill 概念（目录 + 渐进式披露 + 工具白名单）完全不是一个东西。

### 2.5 演示文稿：模板填空（M5 前历史基线）

M5 前链路是自研的一套简化模型：

- `src/lib/slide-types.ts` — 8 种固定布局（title / content / two-column / image-text / comparison / stats / timeline / section），字段是 `title / body / left / right / stats / items`
- `src/components/artifacts/slides-renderer.tsx` (13.8KB) — HTML 预览
- `src/lib/slide-export.ts` (8.4KB) — pptxgenjs 导出，`switch (layout)` 逐个 case 拼版

**本质是模板填空，不是排版**。表达力天花板很低：模型无法控制任何元素的位置、大小、层级、填充，只能往固定槽位塞文本。这决定了产出的 PPT 永远是「一眼 AI 生成」的观感。

2026-08-17 该链路已删除；旧 8 布局数据在 `src/lib/pptd/migrate-legacy.ts` 边界迁移后统一走 PPTD 预览与导出。

### 2.6 数据与文件

9 张表：`profiles / projects / conversations / messages / artifacts / attachments / knowledge_entries / templates / usage_logs`。RLS 完整，有 pgvector 向量列和全文检索迁移。

`projects` 表只有 `name / description / status / owner_id`（`20250217000001_initial_schema.sql:26`）—— 所谓「项目」目前就是对话的分组标签，没有任何工作区语义。

文件走 `attachments` 表 + Supabase Storage，前端用 mammoth/pdfjs 抽文本存 `extracted_content`。**全部在云端，本地无任何文件概念。**

## 3. 已知缺陷（进入 M1 前应修）

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| D-1 | **artifact 类型约束漂移**：数据库 `CHECK (type IN ('document','slides','code','mermaid','chart'))` 不含 `drawio`，但 TS 类型含 | `20250217000001_initial_schema.sql` vs `src/lib/api/types.ts:62` | 保存 drawio artifact 会触发约束违反 |
| D-2 | artifact id 用 `Date.now()+random` 生成 | `use-chat.ts:338,352,397` | 高频场景理论上可碰撞，且与数据库 UUID 主键不一致 |
| D-3 | 自定义 Skill 只存 localStorage | `stores/skill-store.ts` | 清缓存 / 换设备即丢失 |

## 4. 差距矩阵

对照 [00-vision-and-scope.md](00-vision-and-scope.md) 的四根支柱：

| 支柱 | 现有资产 | 完成度 | 主要缺口 |
|---|---|---|---|
| **文件管理** | 消息附件 + Storage + 文本抽取 | ~5% | 无本地目录、无文件树、无监听、无索引 |
| **项目作业区** | projects 表 + 对话分组 | ~20% | 项目无工作区语义、无阶段、无产出物清单 |
| **Skills** | 10 个 prompt + 自定义 CRUD + 命令面板 | ~30% | 无资源、无工具绑定、无渐进式披露、无版本 |
| **Agent 协作** | 单轮流式对话 | **~0%** | 无工具调用、无循环、无权限、无任务态 |

## 5. 核心判断

**Solidify 现在是「云端 SaaS 架构外面套了个 Tauri 壳」，不是桌面应用。**

数据在 Supabase、AI 走 Edge Function、Rust 层是空的、文件传云存储。这个架构做「AI 对话 + 交付物生成」是称职的，前端 13.7k 行的完成度也确实不低。

但四根支柱要求的是**本地优先的 Agent 工作台**形态，它硬性依赖四件事：

1. 本地文件系统读写 + 目录树 + 变更监听
2. 受控的工具执行（含进程与文件写入）
3. 多轮 agent loop + 工具调用 + 中断恢复
4. 长任务的状态持久化

**这四条一条都没有，且每一条的主战场都在 Rust/Tauri 层 —— 而那层现在是 31 行。**

结论：当前最该补的是**架构深度**（Agent Runtime + 本地能力），而不是**能力宽度**（再加几个 prompt 技能）。这直接决定了 [03-roadmap.md](03-roadmap.md) 的排序。

## 6. 可复用的资产（不要推倒重来）

改造中应保留并在其上生长的部分：

| 资产 | 位置 | 在目标架构中的归属 |
|---|---|---|
| SSE 增量解析与流式状态同步 | `use-chat.ts:249-410` | 升级为 L1 流式管线 |
| 前端直连模型通路 | `ai-providers.ts:122` | L1 Model Gateway 的基础 |
| Artifact 渲染器族（7 个） | `components/artifacts/` | 保留，PPTD 渲染器作为新成员加入 |
| Tauri 能力封装层与 Web 降级模式 | `lib/tauri.ts` | 保留模式，扩充能力集 |
| 模板引擎 + 测试 | `lib/template-engine.ts` | Skill 资源渲染复用 |
| RAG 模块 | `lib/rag/` | L5 长期记忆的检索侧 |
| Supabase schema 与 RLS | `supabase/migrations/` | 降级为同步层，表结构大部分可留 |
