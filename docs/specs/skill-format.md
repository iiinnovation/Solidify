# spec · Skill 格式

> 约束模块：`src/lib/skills/`　对应里程碑：[M4](../phases/M4-skill-system.md)
> 相关决策：[ADR-0004](../04-decisions.md#adr-0004)

## 1. 从字符串到目录

现状（`src/lib/skills.ts`）：一个 Skill 就是一个 `systemPrompt` 字符串，全部内容一次性塞进上下文。

目标：Skill 是一个目录，内容按需加载。

```
requirement-analysis/
├── SKILL.md              入口：frontmatter + 工作流正文（必需）
├── reference/            详细规范，模型按需读取
│   ├── output-format.md
│   └── checklist.md
├── examples/             少样本
│   └── sample-output.md
└── assets/               模板与静态资源
    └── template.docx
```

## 2. SKILL.md

```markdown
---
name: requirement-analysis
displayName: 需求分析
description: 结构化梳理客户需求，输出需求规格文档。当用户提供访谈纪要、调研材料或原始需求描述，需要产出规范的需求文档时使用。
version: 2.0.0
icon: ClipboardList
placeholder: 描述客户需求或粘贴需求相关材料...
allowed-tools: [read_file, write_file, list_dir, search_files]
recommended-models: [claude-sonnet-4, deepseek-chat]
---

# 需求分析

## 何时使用
...

## 工作流
1. 读取用户提供的所有材料
2. 需要完整输出格式规范时，读取 `reference/output-format.md`
3. ...

## 输出约定
...
```

### frontmatter 字段

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | ✅ | 唯一标识，kebab-case，与目录名一致 |
| `description` | ✅ | **最重要的字段**。见 §3 |
| `version` | ✅ | 语义化版本 |
| `displayName` | | UI 显示名，缺省用 name |
| `icon` | | lucide-react 图标名 |
| `placeholder` | | 输入框占位提示 |
| `allowed-tools` | | 工具白名单。**未声明 = 使用默认只读工具集**，不是"全部允许" |
| `recommended-models` | | 推荐模型 |
| `stage` | | 适用的项目阶段，用于排序 |

## 3. 渐进式披露

这是整个 Skill 体系的核心机制。

**问题**：一份完整的 PPTD 格式规范有 2000 行。塞进 system prompt 会挤掉上下文、干扰无关任务、每轮都付 token 成本。

**做法**：分三层加载。

```
第 0 层  始终在上下文       所有 Skill 的 name + description
                          ↓ 全部加起来约 300–600 token
第 1 层  Skill 被选中时     该 Skill 的 SKILL.md 正文 + allowed-tools + 资源解析器
                          ↓ 约 500–1500 token，运行开始前完成
第 2 层  模型主动读取       reference/ examples/ assets/ 下的文件
                          ↓ 通过 read_file 工具，按需，可能 0 也可能 5000 token
```

第 0 层由 `injectSkillIndex` hook 注入（见 [harness.md §1](harness.md)），形如：

```
可用的 Skill（需要时用 read_file 读取 .solidify/skills/<name>/SKILL.md 了解详情）：
- requirement-analysis: 结构化梳理客户需求，输出需求规格文档。当用户提供访谈纪要...
- pptd-deck: 制作演示文稿。当用户需要 PPT、幻灯片、汇报材料时使用...
```

### 第 1 层怎么触发

「被选中」有两条路径，都发生在运行开始之前：

1. **手选**：用户在输入框用 `/` 从技能面板挑一个。
2. **自动路由**：用户没手选时，`skills/auto-route.ts` 用一次极小的分类调用
   （温度 0、24 token 上限、8 秒超时）把消息判给某个 Skill 或判为「不启用」。
   可在 Skill 管理页关闭，默认开启。

**为什么不让模型在循环里自己读 SKILL.md 来激活。** 一个 Skill 不只是提示词：
它的 `allowed-tools` 白名单和资源解析器是在 `createChatQueryContext` 构建运行
上下文时挂上去的（见 engine/chat-context.ts、engine/pptd-context.ts）。模型在
循环中途读到 SKILL.md 正文，也拿不到这个 Skill 依赖的工具——例如 `pptd-deck`
的 `generate_pptd`。所以选择必须先于上下文构建完成。

同理，`read_file` 对 `.solidify/skills/...` 的访问由当前已选 Skill 的资源解析器
授权；没有已选 Skill 时这些路径一律拒绝，第 0 层索引里的路径提示只对已激活的
Skill 有效。

### description 怎么写

description 是模型唯一的选择依据。它决定了 Skill 会不会被用上。

- ❌ `一个用于分析需求的技能` —— 说了等于没说
- ✅ `结构化梳理客户需求，输出需求规格文档。当用户提供访谈纪要、调研材料或原始需求描述，需要产出规范的需求文档时使用。`

写法要点：**先说做什么，再说什么时候用**。列举触发场景的具体词汇（"访谈纪要""调研材料"），模型的匹配靠这些。

## 4. 加载位置与优先级

```
项目级   <项目>/.solidify/skills/          最高，可覆盖同名
用户级   ~/.solidify/skills/               用户安装的
内置     应用 bundle 内                     随版本发布
```

同名时高优先级完全替换低优先级（不做字段级合并 —— 合并的行为难以预测）。

## 5. 工具白名单

`allowed-tools` 在 `ToolRegistry.resolve()` 中生效（见 [tool-interface.md §7](tool-interface.md)）：

```ts
const available = registry.resolve({
  platform,
  skill: activeSkill,        // ← 白名单在这里过滤
  userSettings,
})
```

关键约束：

- **未声明 `allowed-tools` ≠ 全部允许**。缺省是默认只读工具集（`read_file` / `list_dir` / `search_files`）
- 白名单只能**收窄**，不能扩展。Skill 不能声明一个未注册的工具，也不能绕过用户的全局禁用
- 白名单不改变权限判定。声明了 `write_file` 仍然要过 PolicyEngine 的 `ask`

## 6. Skill 内的可执行内容

⚠️ **Skill 不能包含任意脚本并被直接执行。**

见 [ADR-0004](../04-decisions.md#adr-0004) 的安全约束。如果某个 Skill 确实需要执行程序（例如文档格式转换），正确做法是：

1. 在 L2 注册一个**用途明确**的工具（如 `convert_document`），白名单可执行文件与参数形状
2. Skill 在 `allowed-tools` 中声明该工具
3. 该工具照常受权限策略约束

而不是提供一个 `run_script` 让 Skill 塞任意命令进去。

## 7. 迁移现有 10 个 Skill

现有内容在 `src/lib/skills.ts`，每个 Skill 的 `systemPrompt` 里其实已经混杂了三种内容，迁移时要拆开：

| 原 systemPrompt 中的内容 | 迁移去向 |
|---|---|
| "什么时候用、要干什么" | SKILL.md 正文 |
| 详细的输出结构、表格模板、语法规范 | `reference/output-format.md` |
| 具体的例子（如 Mermaid 语法示例） | `examples/` |

以 `solution-design` 为例，它的 prompt 里有一大段 Mermaid 架构图语法规范（`skills.ts:73-102`）——这段应该进 `reference/mermaid-syntax.md`，只在模型确实要画架构图时才读。

迁移清单：

```
requirement-analysis  solution-design  demo-code  gap-analysis  test-plan
meeting-notes  report-outline  glossary  presentation  drawio-diagram
```

`presentation` 在 M5 会被 PPTD 版本替换，M4 阶段先平移。

## 8. 用户自定义 Skill

现状是 localStorage（`src/stores/skill-store.ts`）。M4 迁移到 `~/.solidify/skills/`。

- 提供一次性迁移：读 localStorage → 写成目录 → 标记已迁移
- UI 上「新建 Skill」创建目录并打开编辑器
- 支持把一个 Skill 目录导出为 zip，以及导入

## 9. 版本与兼容

- `version` 用语义化版本
- 运行账本记录每次运行使用的 Skill 名称 + 版本（[harness.md §4](harness.md)）
- Skill 更新不影响历史运行的可解释性

## 10. Web 端降级

Web 端无文件系统：

- 内置 Skill 打包进 bundle，由 `SkillResourceResolver` 把虚拟路径映射到内存内容
- 用户级/项目级 Skill 不可用
- 选中内置 Skill 时仅开放 `read_file` 读取当前 Skill 的虚拟根；普通工作区路径和其他 Skill 根仍拒绝
- 第 2 层继续由模型按需读取，不直接注入 system prompt

## 11. 验收测试

| 用例 | 期望 |
|---|---|
| 拖入一个 Skill 目录到 `~/.solidify/skills/` | 命令面板中出现，无需重启 |
| 未选中任何 Skill 时提问 | 上下文中只有 Skill 索引（< 600 token），无正文 |
| 选中 PPTD Skill 后要求做 PPT | 模型主动 `read_file` 读取 `reference/pptd.md` |
| Skill 声明 `allowed-tools: [read_file]` 后要求写文件 | 模型看不到 `write_file`，不会尝试调用 |
| 项目级与用户级同名 Skill | 项目级生效 |
| SKILL.md frontmatter 缺 `description` | 加载失败并给出明确错误，不静默忽略 |
| 从 localStorage 迁移 3 个自定义 Skill | 全部变成目录，内容一致 |
