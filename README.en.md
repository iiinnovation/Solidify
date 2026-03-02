# Solidify

<div align="center">

**AI-Powered Delivery Workbench**

A lightweight AI tool designed for non-technical implementation professionals, focusing on document generation, presentation preparation, and knowledge management.

[简体中文](./README.md) | English

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-orange)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://reactjs.org/)

</div>

## ✨ Features

- 🤖 **AI-Powered** - Support for Claude, GPT-4, DeepSeek, and more
- 📝 **9 Built-in Skills** - Requirements analysis, solution design, presentations, test plans, etc.
- 🎨 **Multi-Format Export** - PPTX, PDF, DOCX, Markdown, HTML
- 📊 **Rich Visualizations** - 8 slide layouts, Mermaid diagrams, data charts
- 📁 **File Upload** - Extract content from PDF, DOCX, TXT, MD, CSV files
- 🗂️ **Knowledge Base** - RAG enhancement with RagFlow integration
- 🎯 **Template System** - Custom document templates for standardized content
- 🌓 **Dark Mode** - Auto-follow system or manual toggle
- ⚡ **Lightweight & Fast** - Tauri packaging, ~50MB size, <1s startup
- 🔄 **Cloud Sync** - Optional Supabase cloud storage for multi-device sync

## 🎯 Use Cases

Solidify is designed for:

- **Implementation Engineers** - Quickly generate implementation plans, deployment docs, test reports
- **Pre-sales Consultants** - Prepare presentations, product intros, solution comparisons
- **Project Managers** - Organize meeting notes, project reports, progress updates
- **Technical Support** - Write operation manuals, FAQ docs, issue analysis

## 🚀 Quick Start

### Download & Install

#### macOS

```bash
# Download DMG installer
# Get the latest version from Releases page
open Solidify_0.1.0_x64.dmg
```

#### Windows

```bash
# Download MSI installer
# Get the latest version from Releases page
```

#### Web Version

Visit [https://solidify.app](https://solidify.app) (if deployed)

### Configure AI API

First-time setup requires AI API Key configuration:

1. Open Settings page
2. Select AI model provider (OpenAI / Anthropic / DeepSeek)
3. Enter API Key
4. Save configuration

Supported AI models:

- **OpenAI**: GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
- **Anthropic**: Claude 3.5 Sonnet, Claude 3 Opus
- **DeepSeek**: DeepSeek Chat, DeepSeek Coder

### Optional: Configure Supabase (Cloud Sync)

If you need cloud storage and multi-device sync:

1. Create Supabase project: https://supabase.com
2. Configure Supabase URL and Anon Key in settings
3. Register and login
4. Local data will automatically sync to cloud

## 🛠️ Local Development

### Requirements

- Node.js 18+
- npm 9+
- Rust 1.70+ (Tauri development only)

### Install Dependencies

```bash
git clone https://github.com/your-org/solidify.git
cd solidify
npm install
```

### Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` file with necessary environment variables:

```bash
# AI API Keys (at least one required)
VITE_OPENAI_API_KEY=sk-...
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_DEEPSEEK_API_KEY=sk-...

# Supabase (optional, for cloud storage)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...

# RAG Provider (optional)
VITE_RAG_PROVIDER=supabase  # or ragflow
VITE_RAGFLOW_API_URL=http://localhost:9380
VITE_RAGFLOW_API_KEY=ragflow-...
```

### Development Mode

```bash
# Web development mode
npm run dev

# Tauri development mode (desktop)
npm run tauri:dev
```

### Build

```bash
# Web build
npm run build

# Tauri build (desktop)
npm run tauri:build
```

## 📖 User Guide

### Basic Usage

1. **Create Project** - Create new project in sidebar to organize conversations
2. **Select Skill** - Type `/` to open skill palette and select appropriate skill
3. **Input Requirements** - Describe your needs, AI generates content based on skill
4. **View Artifact** - Generated docs, PPTs, charts appear in right panel
5. **Export Content** - Click export button and select desired format

### 9 Built-in Skills

| Skill | Description | Recommended Models |
|-------|-------------|-------------------|
| 📋 Requirements Analysis | Output numbered functional requirements list | General |
| 🏗️ Solution Design | Generate technical solution docs + architecture diagrams | General |
| 💻 Demo Code | Generate single-file HTML demos | General |
| 📊 Gap Analysis | Gap matrix table + matching scores | General |
| ✅ Test Plan | UAT test cases + acceptance criteria | General |
| 📝 Meeting Notes | Organize recordings/notes into structured minutes | General |
| 📑 Report Outline | Generate report outline based on audience | General |
| 📖 Glossary | Plain analogies + implementation scenarios | General |
| 🎨 Presentation | Generate JSON-structured slides | Claude, GPT-4 |

### File Upload

Supports uploading files in the following formats, AI automatically extracts content:

- 📄 Documents: PDF, DOCX, TXT, MD
- 📊 Spreadsheets: CSV
- 🖼️ Images: PNG, JPG (placeholder display)

### Knowledge Base (RAG)

Upload project-related documents to knowledge base, AI automatically references relevant knowledge:

1. Go to Knowledge Base page
2. Upload documents (supports PDF, DOCX, TXT, MD)
3. System automatically extracts and indexes
4. AI automatically searches relevant knowledge during conversations

**Supports external knowledge base integration**:

- RagFlow
- Other compatible RAG systems

### Template System

Create custom templates for quick standardized document generation:

1. Go to Templates page
2. Create new template
3. Use variable syntax: `{{variable}}`
4. Use template in conversations

## 🏗️ Technical Architecture

### Tech Stack

- **Frontend**: Vite + React 18 + TypeScript + Tailwind CSS v4
- **Desktop**: Tauri v2 (Rust + WebView)
- **State Management**: Zustand + TanStack Query
- **Backend**: Supabase (Auth + PostgreSQL + Edge Functions + Storage)
- **AI**: Direct API calls or proxy through Edge Functions
- **Vector Search**: pgvector (PostgreSQL extension)

### Architecture Features

- **Cloud-First** - Prioritize cloud storage with offline fallback
- **Lightweight** - Tauri packaging, small size, high performance
- **Extensible** - Modular design, easy to extend new features
- **Cross-Platform** - Web + macOS + Windows, single codebase

### Directory Structure

```
Solidify/
├── src/                      # Frontend source code
│   ├── components/          # UI components
│   │   ├── artifacts/      # Artifact rendering
│   │   ├── chat/           # Chat interface
│   │   ├── knowledge/      # Knowledge base
│   │   ├── layout/         # Layout components
│   │   └── templates/      # Template management
│   ├── hooks/              # Custom Hooks
│   ├── lib/                # Core logic
│   │   ├── api/           # API calls
│   │   ├── rag/           # RAG interface layer
│   │   └── ...
│   ├── routes/             # Page routing
│   └── stores/             # State management
├── src-tauri/              # Tauri desktop
│   ├── src/               # Rust code
│   └── icons/             # App icons
├── supabase/               # Supabase config
│   ├── functions/         # Edge Functions
│   └── migrations/        # Database migrations
└── .claude/                # Claude Code config
    └── skills/            # Skill documentation
```

## 🤝 Contributing

We welcome all forms of contribution! Please read the [Contributing Guide](./CONTRIBUTING.md) for details.

### Development Workflow

1. Fork this repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'feat: add some feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Create Pull Request

## 📝 License

This project is open source under the [MIT License](./LICENSE).

## 🙏 Acknowledgments

- [Tauri](https://tauri.app/) - Lightweight desktop app framework
- [Supabase](https://supabase.com/) - Open source Firebase alternative
- [React](https://reactjs.org/) - UI framework
- [Tailwind CSS](https://tailwindcss.com/) - CSS framework
- [Mermaid](https://mermaid.js.org/) - Diagram rendering
- [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) - PPTX generation

## 📧 Contact

- GitHub Issues: [Report Issues](https://github.com/your-org/solidify/issues)
- GitHub Discussions: [Technical Discussions](https://github.com/your-org/solidify/discussions)

---

**Core Value**: Complete 2 hours of documentation work in 10 minutes ⚡
