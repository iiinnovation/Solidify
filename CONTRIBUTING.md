# 贡献指南

感谢你对 Solidify 的关注！我们欢迎所有形式的贡献。

## 🌟 如何贡献

### 报告问题

如果你发现了 bug 或有功能建议：

1. 在 [Issues](https://github.com/your-org/solidify/issues) 中搜索是否已有相关问题
2. 如果没有，创建新的 Issue，并提供：
   - 清晰的标题和描述
   - 复现步骤（如果是 bug）
   - 期望行为和实际行为
   - 截图或错误日志（如果适用）
   - 环境信息（操作系统、浏览器版本等）

### 提交代码

1. **Fork 仓库**
   ```bash
   # Fork 后克隆到本地
   git clone https://github.com/your-username/solidify.git
   cd solidify
   ```

2. **创建分支**
   ```bash
   git checkout -b feature/your-feature-name
   # 或
   git checkout -b fix/your-bug-fix
   ```

3. **安装依赖**
   ```bash
   npm install
   ```

4. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 文件，填入必要的配置
   ```

5. **开发和测试**
   ```bash
   # Web 开发模式
   npm run dev

   # Tauri 开发模式
   npm run tauri:dev

   # 运行测试
   npm test
   ```

6. **提交代码**
   ```bash
   git add .
   git commit -m "feat: 添加新功能"
   # 或
   git commit -m "fix: 修复某个问题"
   ```

7. **推送并创建 Pull Request**
   ```bash
   git push origin feature/your-feature-name
   ```

   然后在 GitHub 上创建 Pull Request。

## 📝 代码规范

### Commit 消息格式

我们使用语义化的 commit 消息：

```
<type>: <subject>

<body>
```

**Type 类型：**
- `feat`: 新功能
- `fix`: Bug 修复
- `docs`: 文档更新
- `style`: 代码格式调整（不影响功能）
- `refactor`: 重构（不是新功能也不是 bug 修复）
- `perf`: 性能优化
- `test`: 测试相关
- `chore`: 构建工具或辅助工具的变动

**示例：**
```
feat: 添加知识库上传功能

- 支持 PDF/DOCX/TXT/MD 文件上传
- 自动提取文本内容
- 显示上传进度
```

### 代码风格

- **语言**: TypeScript (strict mode)
- **组件**: 函数式组件 + Hooks
- **样式**: Tailwind CSS
- **命名**:
  - 文件: `kebab-case.tsx`
  - 组件: `PascalCase`
  - 函数/变量: `camelCase`
  - 常量: `UPPER_SNAKE_CASE`

### 目录结构

```
src/
├── components/        # UI 组件
│   ├── artifacts/    # Artifact 相关
│   ├── chat/         # 聊天相关
│   ├── layout/       # 布局组件
│   ├── shared/       # 共享组件
│   └── ui/           # 基础 UI 组件
├── hooks/            # 自定义 Hooks
├── lib/              # 工具函数和核心逻辑
├── routes/           # 页面路由
└── stores/           # 状态管理 (Zustand)
```

## 🧪 测试

在提交 PR 前，请确保：

- [ ] 代码通过 TypeScript 类型检查 (`npm run build`)
- [ ] 所有测试通过 (`npm test`)
- [ ] 新功能有对应的测试用例
- [ ] 代码符合项目的编码规范

## 📚 开发文档

- [CLAUDE.md](./CLAUDE.md) - 项目架构和开发指南
- [.claude/skills/](./claude/skills/) - 各模块的详细文档
  - `ui-design.md` - UI 设计系统
  - `frontend.md` - 前端架构
  - `backend.md` - 后端架构
  - `shared-contract.md` - 前后端契约

## 🔧 开发环境

### 必需工具

- Node.js 18+
- npm 9+
- Rust 1.70+ (仅 Tauri 开发)

### 可选工具

- Supabase CLI (本地开发数据库)
- Docker (运行本地 Supabase)

### 环境变量

参考 `.env.example` 文件配置以下环境变量：

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

## 🚀 发布流程

发布由维护者负责，流程如下：

1. 更新版本号 (`package.json`, `src-tauri/tauri.conf.json`)
2. 更新 CHANGELOG.md
3. 创建 Git tag
4. 推送到 GitHub
5. GitHub Actions 自动构建和发布

## 💬 社区

- GitHub Issues: 问题反馈和功能建议
- GitHub Discussions: 技术讨论和问答

## 📄 许可证

通过贡献代码，你同意你的贡献将在 [MIT License](./LICENSE) 下发布。

---

再次感谢你的贡献！🎉
