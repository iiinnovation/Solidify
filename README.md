# Solidify 2

<div align="center">

**第二代本地优先 AI 实施交付工作台 · Beta**

面向实施工程师、售前顾问和项目团队，将对话、项目文件、Skill、Agent 工具与可交付成果放进同一个工作区。

[English](./README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-2.0.0--beta.1-2f855a)](./CHANGELOG.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)

</div>

> Solidify 2 目前处于 Beta 阶段，尚未提供正式的 macOS / Windows 安装包。部分工作台、PPTD 和多 Agent 能力仍通过设置页的实验开关控制。

## 为什么是 Solidify 2

Solidify 2 不是对第一版界面的简单改版，而是将产品从“AI 对话 + Artifact”重构为可持续执行项目任务的本地交付工作台。

| 第一版 | Solidify 2 |
|---|---|
| 对话与 Artifact 双栏工具 | 文件、对话、交付物和版本统一的本地工作区 |
| 单轮生成链路 | 可恢复的多轮 Agent 与原生工具调用 |
| 将 Skill 作为内联 Prompt 注入 | 目录式 Skill、自动路由和参考资料渐进披露 |
| 主要依赖完整历史消息 | 按模型窗口重新编译、去重和裁剪上下文 |
| 切换对话会影响当前任务 | 多会话后台运行，导航与任务生命周期分离 |
| 生成结果即最终输出 | Harness 审批、运行账本、Snapshot 和交付物版本管理 |

## 核心能力

- **统一工作区**：在桌面端打开本地项目目录，浏览文件、对话、交付物和版本记录；项目元数据保存在工作区的 `.solidify/` 目录。
- **多轮 Agent 运行时**：支持 Provider 原生工具调用、流式输出、工具结果回传、循环保护、审批和运行账本。
- **并行会话运行**：切换或新建对话不会中止正在执行的会话；删除会话、停止任务或切换工作区时才会取消相应运行。
- **可控上下文**：每轮重新编译历史、附件、工作区检索结果、Skill 和工具结果，并按照模型窗口执行预算、去重、句柄化与成对裁剪。
- **目录式 Skill**：内置 10 个交付 Skill，支持自动路由、渐进式披露、参考资料按需读取和工具白名单。
- **附件与知识检索**：支持 PDF、DOCX、Markdown、文本、CSV 和图片；大附件按 manifest 与读取工具渐进加载，避免整份内容反复进入上下文。
- **Artifact 预览与导出**：按需打开右侧预览，支持文档、HTML、Mermaid、图表、Draw.io 和 PPTD 演示文稿。
- **PPTD 演示引擎**：从来源索引、设计方向和大纲生成可校验的演示文稿，支持逐页预览和 PPTX 导出。
- **多模型接入**：提供 OpenAI、Anthropic、DeepSeek 模板，也支持自定义 OpenAI / Anthropic 兼容端点。
- **中断恢复**：完成的工具轮会写入 Snapshot，异常退出后可从最后一个有效快照继续，而不是从头执行。

## 运行方式

```text
持久化会话
  -> 固定 Provider、工作区、Skill 和工具权限
  -> 注入当前附件、工作区检索和 Memory
  -> 编译上下文预算并清理工具消息配对
  -> 调用模型并执行工具循环
  -> 每轮写入 Snapshot
  -> 将最终回答与 Artifact 写回会话
```

会话历史会被保留，但不会无上限地原样发送给模型。工作区检索内容以不可信的 user-role 数据注入；工具 Schema 使用 Provider 原生 `tools` 字段；大工具结果会转换为可按需读取的 handle。详细约束参见 [Agent 查询循环规格](./docs/specs/agent-loop.md) 和 [Harness 规格](./docs/specs/harness.md)。

## 快速开始

### 环境要求

- Node.js 20.19+ 或 22.12+
- npm 9+
- Rust stable（仅桌面端开发和构建需要）
- macOS 10.15+、Windows 或支持 WebView 的 Linux 桌面环境

### 安装与启动

```bash
git clone https://github.com/iiinnovation/Solidify.git
cd Solidify
npm install

# Web 开发模式
npm run dev

# 桌面端开发模式
npm run tauri:dev
```

`npm run tauri:dev` 会通过 Tauri 的 `beforeDevCommand` 自动启动 Vite，不需要先单独运行 `npm run dev`。

### 配置模型

首次启动后进入“设置”，添加模型 Provider：

1. 选择预设模板或自定义 API 格式。
2. 填写完整 API URL、API Key 和模型 ID。
3. 按模型能力设置工具调用、视觉输入、上下文窗口和单轮输出上限。
4. 保存并将该 Provider 设为当前模型。

API Key 默认只存储在本地应用数据中。开发模式通过 Vite 本地代理转发模型请求；未配置 Supabase 的生产构建会直接请求所配置的 Provider。

### 可选后端

登录、用量统计、云端知识库和 Edge Function 模型代理依赖 Supabase。需要这些能力时，在项目根创建 `.env.local`：

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

外部 RAG 可另外配置 RagFlow：

```bash
VITE_RAG_PROVIDER=ragflow
VITE_RAGFLOW_API_URL=http://localhost:9380
VITE_RAGFLOW_API_KEY=your-ragflow-key
```

部署 `chat` Edge Function 前，应先配置允许访问的自定义模型主机。官方 OpenAI、Anthropic、DeepSeek、DashScope、智谱和 Moonshot 主机已在服务端策略中受控处理：

```bash
supabase secrets set MODEL_PROXY_ALLOWED_HOSTS=api.example.com,models.example.org
supabase functions deploy chat
```

## 桌面端端口排查

Tauri 开发配置固定连接 `http://127.0.0.1:5173`。如果出现 `Port 5173 is already in use`，先检查占用进程：

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
kill <PID>
npm run tauri:dev
```

不要同时启动两份 Vite。若需要保留占用 5173 的进程，应同步修改 `src-tauri/tauri.conf.json` 中的 `devUrl` 和 Vite 启动端口，保证两者一致。

## 内置 Skill

| Skill | 主要输出 |
|---|---|
| 需求分析 | 结构化需求规格与验收边界 |
| 方案设计 | 技术方案、组件关系与实施路径 |
| 演示代码 | 可直接运行的单文件 HTML Demo |
| Draw.io 流程图 | 可编辑的流程图或系统架构图 |
| 差距分析 | 差距矩阵、匹配度与定制建议 |
| 测试方案 | UAT 用例、验收标准与覆盖矩阵 |
| 会议纪要 | 决议、风险、负责人和待办 |
| 汇报大纲 | 面向具体受众的汇报结构 |
| 术语解释 | 通俗定义、类比和实施场景 |
| PPTD 演示文稿 | 可预览、校验并导出 PPTX 的演示文稿 |

Skill 来源位于 `src/lib/skills/builtin/`。修改内置 Skill 后运行 `npm run compile:skills`，不要手工编辑生成的 manifest。

## Artifact 与导出

| Artifact 类型 | 支持的导出格式 |
|---|---|
| 文档 | Markdown、HTML、DOCX、PDF |
| HTML Demo | HTML |
| Mermaid | SVG、PNG |
| 数据图表 | PNG |
| Draw.io | `.drawio`；SVG/PNG 通过编辑模式导出 |
| PPTD 演示文稿 | PPTX、PDF |

Artifact 面板默认不占用工作区，用户从消息或交付物入口打开后才挂载预览。

## 开发命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 Web 开发服务器 |
| `npm run tauri:dev` | 启动 Tauri 桌面端开发环境 |
| `npm run test:run` | 运行全部 Vitest 测试 |
| `npm run lint` | 运行 ESLint |
| `npm run build` | 编译 Skill、检查上下文预算、执行 TypeScript 检查并构建 Web 产物 |
| `npm run tauri:build` | 构建桌面安装产物 |
| `npm run check:context-budgets` | 校验系统提示词、Skill 和工具 Schema 的预算 |
| `npm run check:agent-benchmark` | 检查 Agent 基准结果是否满足门槛 |

Web 产物输出到 `dist/`，桌面构建产物输出到 `src-tauri/target/release/`。

## 技术架构

- **前端**：Vite 7、React 19、TypeScript 5.9、Tailwind CSS 4
- **桌面端**：Tauri 2、Rust、系统 WebView
- **状态管理**：Zustand、TanStack Query
- **Agent Runtime**：上下文编译器、工具注册表、Harness、Snapshot、子 Agent
- **模型接入**：OpenAI SDK、Anthropic SDK、兼容端点和可选 Supabase Edge Relay
- **文档与演示**：Markdown、Mermaid、Draw.io、PPTD、PptxGenJS
- **可选服务**：Supabase Auth / PostgreSQL / Edge Functions、RagFlow

```text
Solidify/
├── src/
│   ├── components/          # 对话、工作台、Artifact 和通用 UI
│   ├── hooks/               # 会话与 Agent 运行编排
│   ├── lib/
│   │   ├── attachments/     # 附件存储、提取和渐进读取
│   │   ├── engine/          # Agent 循环、上下文编译和 Snapshot
│   │   ├── harness/         # Hook、审批、Guard、账本和遥测
│   │   ├── model/           # Provider 适配与流式传输
│   │   ├── pptd/            # 演示文稿生成、校验、预览和导出
│   │   ├── skills/          # 内置 Skill、编译器和自动路由
│   │   ├── tools/           # 工具注册表与内置工具
│   │   └── workspace/       # 本地文件、索引、检索和持久化
│   ├── routes/              # 页面路由
│   └── stores/              # Zustand 状态
├── src-tauri/               # Tauri 配置、Rust 命令和桌面能力
├── supabase/                # 数据库迁移与 Edge Functions
├── benchmarks/              # Agent 请求链路基准
├── scripts/                 # Skill、预算和 PPTD 维护脚本
└── docs/                    # 产品、架构、规格和 ADR
```

## 数据与安全边界

- 本地工作区文件操作必须位于已授权的工作区根目录内。
- 写入、覆盖和删除由 Harness 策略决定是否允许、询问或拒绝；硬 Guard 不能被审批绕过。
- 工作区 RAG 和附件内容按不可信数据处理，不进入系统提示词的可信指令层。
- 运行账本只保存诊断所需的模型参数和摘要，不持久化完整请求正文或模型回答。
- 配置 Supabase 后，模型代理要求有效登录态，并按服务端主机白名单转发请求。

## 文档

- [产品与架构文档](./docs/README.md)
- [Agent 查询循环](./docs/specs/agent-loop.md)
- [工具接口](./docs/specs/tool-interface.md)
- [Harness 安全控制](./docs/specs/harness.md)
- [工作区格式](./docs/specs/workspace-format.md)
- [Skill 格式](./docs/specs/skill-format.md)
- [PPTD 支持范围](./docs/specs/pptd-subset.md)

## 贡献与许可证

提交改动前至少运行：

```bash
npm run test:run
npm run lint
npm run build
```

贡献流程参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。项目采用 [MIT License](./LICENSE)。

- [GitHub Issues](https://github.com/iiinnovation/Solidify/issues)
- [GitHub Discussions](https://github.com/iiinnovation/Solidify/discussions)
