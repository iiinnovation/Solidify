# Solidify

<div align="center">

**AI 驱动的实施交付工作台**

一款专为非研发背景实施人员打造的轻量级 AI 工具，专注文档生成、演示准备和知识管理。

[English](./README.en.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://reactjs.org/)

</div>

## ✨ 特性

- 🤖 **AI 驱动** - 支持 Claude、GPT-4、DeepSeek 等多种 AI 模型
- 📝 **9 个内置技能** - 需求分析、方案设计、演示文稿、测试方案等
- 🎨 **多格式导出** - PPTX、PDF、DOCX、Markdown、HTML
- 📊 **丰富的可视化** - 8 种幻灯片布局、Mermaid 图表、数据图表
- 📁 **文件上传** - 支持 PDF、DOCX、TXT、MD、CSV 文件内容提取
- 🗂️ **知识库** - RAG 增强，支持接入 RagFlow 等知识库系统
- 🎯 **模板系统** - 自定义文档模板，快速生成标准化内容
- 🌓 **深色模式** - 自动跟随系统或手动切换
- ⚡ **轻量快速** - Tauri 打包，体积小（~50MB），启动快（<1s）
- 🔄 **云端同步** - 可选的 Supabase 云端存储，多设备同步

## 🎯 适用场景

Solidify 专为以下人群设计：

- **实施工程师** - 快速生成实施方案、部署文档、测试报告
- **售前顾问** - 准备演示文稿、产品介绍、方案对比
- **项目经理** - 整理会议纪要、项目汇报、进度报告
- **技术支持** - 编写操作手册、FAQ 文档、问题分析

## 🚀 快速开始

### 下载安装

#### macOS

```bash
# 下载 DMG 安装包
# 从 Releases 页面下载最新版本
open Solidify_0.1.0_x64.dmg
```

#### Windows

```bash
# 下载 MSI 安装包
# 从 Releases 页面下载最新版本
```

#### Web 版本

访问 [https://solidify.app](https://solidify.app)（如果已部署）

### 配置 AI API

首次使用需要配置 AI API Key：

1. 打开设置页面
2. 选择 AI 模型提供商（OpenAI / Anthropic / DeepSeek）
3. 输入 API Key
4. 保存配置

支持的 AI 模型：

- **OpenAI**: GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
- **Anthropic**: Claude 3.5 Sonnet, Claude 3 Opus
- **DeepSeek**: DeepSeek Chat, DeepSeek Coder

### 可选：配置 Supabase（云端同步）

如果需要云端存储和多设备同步：

1. 创建 Supabase 项目：https://supabase.com
2. 在设置中配置 Supabase URL 和 Anon Key
3. 注册账号并登录
4. 本地数据将自动同步到云端

## 🛠️ 本地开发

### 环境要求

- Node.js 18+
- npm 9+
- Rust 1.70+ (仅 Tauri 开发)

### 安装依赖

```bash
git clone https://github.com/your-org/solidify.git
cd solidify
npm install
```

### 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置必要的环境变量：

```bash
# AI API Keys (至少配置一个)
VITE_OPENAI_API_KEY=sk-...
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_DEEPSEEK_API_KEY=sk-...

# Supabase (可选，用于云端存储)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# RAG Provider (可选)
VITE_RAG_PROVIDER=supabase  # 或 ragflow
VITE_RAGFLOW_API_URL=http://localhost:9380
VITE_RAGFLOW_API_KEY=ragflow-...
```

### 开发模式

```bash
# Web 开发模式
npm run dev

# Tauri 开发模式（桌面端）
npm run tauri:dev
```

### 构建

```bash
# Web 构建
npm run build

# Tauri 构建（桌面端）
npm run tauri:build
```

## 📖 使用指南

### 基础使用

1. **创建项目** - 在侧边栏创建新项目，组织你的对话
2. **选择技能** - 输入 `/` 唤起技能面板，选择合适的技能
3. **输入需求** - 描述你的需求，AI 会根据技能生成对应内容
4. **查看 Artifact** - 生成的文档、PPT、图表会显示在右侧面板
5. **导出内容** - 点击导出按钮，选择需要的格式

### 9 个内置技能

| 技能 | 说明 | 推荐模型 |
|------|------|---------|
| 📋 需求分析 | 输出带编号的功能需求清单 | 通用 |
| 🏗️ 方案设计 | 生成技术方案文档 + 架构图 | 通用 |
| 💻 演示代码 | 生成单文件 HTML Demo | 通用 |
| 📊 差距分析 | 差距矩阵表格 + 匹配度评分 | 通用 |
| ✅ 测试方案 | UAT 测试用例 + 验收标准 | 通用 |
| 📝 会议纪要 | 从录音/笔记整理结构化纪要 | 通用 |
| 📑 汇报大纲 | 根据受众生成汇报大纲 | 通用 |
| 📖 术语解释 | 通俗类比 + 实施场景 | 通用 |
| 🎨 演示文稿 | 生成 JSON 结构化幻灯片 | Claude, GPT-4 |

### 文件上传

支持上传以下格式的文件，AI 会自动提取内容：

- 📄 文档：PDF, DOCX, TXT, MD
- 📊 表格：CSV
- 🖼️ 图片：PNG, JPG（显示占位符）

### 知识库（RAG）

上传项目相关文档到知识库，AI 会自动引用相关知识回答问题：

1. 进入知识库页面
2. 上传文档（支持 PDF、DOCX、TXT、MD）
3. 系统自动提取和索引
4. 在对话中 AI 会自动搜索相关知识

**支持接入外部知识库**：

- RagFlow
- 其他兼容的 RAG 系统

### 模板系统

创建自定义模板，快速生成标准化文档：

1. 进入模板页面
2. 创建新模板
3. 使用变量语法：`{{variable}}`
4. 在对话中使用模板

## 🏗️ 技术架构

### 技术栈

- **前端**: Vite + React 18 + TypeScript + Tailwind CSS v4
- **桌面端**: Tauri v2 (Rust + WebView)
- **状态管理**: Zustand + TanStack Query
- **后端**: Supabase (Auth + PostgreSQL + Edge Functions + Storage)
- **AI**: 直接调用 API 或通过 Edge Functions 代理
- **向量搜索**: pgvector (PostgreSQL 扩展)

### 架构特点

- **云优先** - 优先使用云端存储，支持离线降级
- **轻量级** - Tauri 打包，体积小，性能好
- **可扩展** - 模块化设计，易于扩展新功能
- **跨平台** - Web + macOS + Windows，一套代码

### 目录结构

```
Solidify/
├── src/                      # 前端源代码
│   ├── components/          # UI 组件
│   │   ├── artifacts/      # Artifact 渲染
│   │   ├── chat/           # 聊天界面
│   │   ├── knowledge/      # 知识库（新增）
│   │   ├── layout/         # 布局组件
│   │   └── templates/      # 模板管理
│   ├── hooks/              # 自定义 Hooks
│   ├── lib/                # 核心逻辑
│   │   ├── api/           # API 调用
│   │   ├── rag/           # RAG 接口层（新增）
│   │   └── ...
│   ├── routes/             # 页面路由
│   └── stores/             # 状态管理
├── src-tauri/              # Tauri 桌面端
│   ├── src/               # Rust 代码
│   └── icons/             # 应用图标
├── supabase/               # Supabase 配置
│   ├── functions/         # Edge Functions
│   └── migrations/        # 数据库迁移
└── .claude/                # Claude Code 配置
    └── skills/            # 技能文档
```

## 🤝 贡献

我们欢迎所有形式的贡献！请阅读 [贡献指南](./CONTRIBUTING.md) 了解详情。

### 开发流程

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: 添加某个功能'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📝 许可证

本项目采用 [MIT License](./LICENSE) 开源。

## 🙏 致谢

- [Tauri](https://tauri.app/) - 轻量级桌面应用框架
- [Supabase](https://supabase.com/) - 开源的 Firebase 替代品
- [React](https://reactjs.org/) - UI 框架
- [Tailwind CSS](https://tailwindcss.com/) - CSS 框架
- [Mermaid](https://mermaid.js.org/) - 图表渲染
- [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) - PPTX 生成

## 📧 联系方式

- GitHub Issues: [问题反馈](https://github.com/your-org/solidify/issues)
- GitHub Discussions: [技术讨论](https://github.com/your-org/solidify/discussions)

---

**核心价值**：10 分钟完成 2 小时的文档工作 ⚡
