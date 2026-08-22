# M4 · Skill 体系

| | |
|---|---|
| **层** | L4 |
| **工期** | 2–3 周（约 11–13 pd） |
| **前置** | M2（工具白名单需要权限层）、M3（Skill 存文件系统） |
| **规格** | [specs/skill-format.md](../specs/skill-format.md) |
| **相关决策** | [ADR-0004](../04-decisions.md#adr-0004) |
| **特性开关** | `skillV2` |
| **状态** | ✅ 基础能力完成；M4-R 链路改进进行中（2026-08-22） |

> **归档决定（2026-08-15）**：目录加载、渐进式披露、工具白名单、管理 UI 与基础自动化验收完成，M4 形成稳定检查点。M4-R 后续继续处理运行中激活、上下文编译、provider 缓存、旧 localStorage 写路径退出和真实质量门禁；旧的双轨兼容代码在迁移窗口结束前保留。

## 目标

把 Skill 从「一个 prompt 字符串」升级为「一个可安装、可版本化、按需加载的能力包」。

M4 是四根支柱中最后一根落地，完成后 [00-vision-and-scope.md §4](../00-vision-and-scope.md) 的典型场景应该能一次交办跑通。

## Demo（验收标准）

> 把一个 Skill 目录拖进 `~/.solidify/skills/`，命令面板中立刻出现，无需重启。
>
> 唤起它并交办任务，运行时间线上能看到统一 `run.phase`；只有任务确实需要详细规范时，模型才调用 `read_file` 读取对应 `reference/`，不再把“第一步读取”作为成功条件。
>
> 不选任何 Skill 时，检查上下文，只有各 Skill 的一行描述，总计不超过 600 token。

## 任务清单

### A. 加载器（4 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M4-01 | SKILL.md frontmatter 解析 + 字段校验 | `src/lib/skills/parse.ts` | 1pd | ✅ |
| M4-02 | 三级目录扫描与优先级合并（项目 > 用户 > 内置） | `src/lib/skills/loader.ts` | 1.5pd | ✅ |
| M4-03 | Skill 注册表 + 索引生成（第 0 层内容） | `src/lib/skills/registry.ts` | 1pd | ✅ |
| M4-04 | 目录变更监听 → 热重载（复用 M3-02 的 watcher） | 同上 | 0.5pd | ✅ |

M4-01 的校验必须**明确失败**：缺 `description` 就报错并在 UI 提示，不要静默跳过。静默失败会让用户以为 Skill 装上了但一直不生效。

### B. 渐进式披露（2 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M4-05 | `injectSkillIndex` hook 接入真实注册表（替换 M2-03 的占位） | `src/lib/harness/builtin-hooks.ts` | 0.5pd | ✅ |
| M4-06 | 选中 Skill 时注入 SKILL.md 正文（第 1 层） | `src/lib/engine/messages.ts` | 0.5pd | ✅ |
| M4-07 | Skill 目录路径注入 system prompt，让模型知道去哪读 | 同上 | 0.5pd | ✅ |
| M4-08 | 上下文 token 统计与预算校验 | `src/lib/engine/messages.ts` | 0.5pd | ✅ |

M4-07 容易被忽略但很关键：模型得知道 `reference/` 在哪。system prompt 里要有类似：

```
当前 Skill: pptd-deck
Skill 目录: .solidify/skills/pptd-deck/
可用参考文档: reference/pptd.md, reference/slide-categories.md
需要详细规范时，用 read_file 读取上述文件。
```

### C. 工具白名单（1 pd）

| # | 任务 | 产出文件 | 估时 |
|---|---|---|---|
| M4-09 | `allowed-tools` 在 `registry.resolve()` 中生效 | `src/lib/tools/registry.ts` | 1pd | ✅ |

三条规则不能错：未声明 = 默认只读集（不是全部）；只能收窄不能扩展；不改变权限判定。

### D. 迁移现有 10 个 Skill（3 pd）

| # | 任务 | 估时 | 状态 |
|---|---|---|---|
| M4-10 | 拆分 `src/lib/skills.ts` 的 10 个 prompt 为目录结构 | 2pd | ✅ |
| M4-11 | 用户自定义 Skill 从 localStorage 迁移到 `~/.solidify/skills/` | 1pd | ✅ |

M4-10 的拆分原则见 [skill-format.md §7](../specs/skill-format.md)：把"什么时候用"留在 SKILL.md，把详细的输出结构、语法规范挪到 `reference/`。

重点例子：`solution-design` 的 Mermaid 语法规范（`skills.ts:73-102`）应该独立成 `reference/mermaid-syntax.md`，只在真要画架构图时读。

### E. UI（2 pd）

| # | 任务 | 产出文件 | 估时 | 状态 |
|---|---|---|---|---|
| M4-12 | Skill 管理页：列表、详情、启用/禁用、删除 | `src/routes/skills.tsx` | 1pd | ✅ |
| M4-13 | Skill 编辑器（新建/编辑 SKILL.md） | `src/routes/skills.tsx` | 0.5pd | ✅ |
| M4-14 | 导入/导出 zip | `src/lib/skills/package.ts` | 0.5pd | ✅ |

现有 `src/hooks/use-skill-palette.ts` 的命令面板保留，数据源换成新注册表。

### F. 测试（1 pd）

| # | 任务 | 估时 | 状态 |
|---|---|---|---|
| M4-15 | [skill-format.md §11](../specs/skill-format.md) 的 7 个用例 | 1pd | ✅ |
| M4-16 | 桌面 GUI Demo、10 Skill 质量对比、典型场景一次性交办与归档门禁 | 0.5pd | ✅ |

自动化覆盖包括目录热重载、无选择时只注入索引、选中 Skill 后真实 `read_file` 资源读取、工具白名单、三级优先级、显式解析错误和 localStorage 三 Skill 迁移。M4 阶段尚无 M5 的 PPTD Skill，因此用内置 `requirement-analysis` / `presentation` 验证相同的第 2 层读取链路。

> 历史记录（不再作为 M4-R 性能门禁）：真实模型验收使用 DeepSeek-compatible OpenAI 协议端点，不配置或回退到 Anthropic。2026-08-15 的 `npm run test:m4-live` 已验证 `deepseek-v4-flash` 在最终回答前依次读取：

```text
.solidify/skills/requirement-analysis/reference/legacy-guidance.md
.solidify/skills/requirement-analysis/reference/output-format.md
```

该次运行共 2 次工具调用、2 轮、4968 tokens，最终状态为 `run.completed`。这证明旧资源解析链路可用，但额外 reference 轮次不代表成功标准；普通 Skill 现在默认直接使用核心规则，只有明确条件成立才读取具体 reference。普通测试默认跳过此付费测试，只有显式执行 `test:m4-live` 才会调用真实模型。

桌面人工验收覆盖全部 10 个迁移 Skill：`demo-code`、`drawio-diagram`、`gap-analysis`、`glossary`、`meeting-notes`、`presentation`、`report-outline`、`requirement-analysis`、`solution-design`、`test-plan`。同输入对比未发现相对旧 prompt 的明显结构或质量退化；目录热加载、管理页导入导出和典型场景的一次性交办均通过。验收中发现模型会猜测不存在的 `examples/` 目录，收口时已改为只向模型列出实际打包的资源文件，并将目录读取明确归类为可恢复的 `invalid_input`，不再误报工作区越界。

## 风险

| 风险 | 应对 |
|---|---|
| 模型不主动读 `reference/` | 仅在任务条件需要时读取具体 reference；不要把“第一步读取”作为验收指标 |
| 迁移后 Skill 效果不如从前 | 迁移一个验证一个，用同样的输入对比产出；不要 10 个一起改完再测 |
| Web 端降级路径遗漏 | M4-15 中包含 Web 端用例 |
| Skill 目录结构约定与生态不一致 | 采用通用 frontmatter 约定，不自创字段名 |

## 完成定义

- [x] Demo 能当着人跑通
- [x] [skill-format.md §11](../specs/skill-format.md) 的 7 个用例全部通过
- [x] 10 个内置 Skill 全部迁移，产出质量不低于迁移前
- [x] 未选 Skill 时上下文中的 Skill 索引 < 600 token
- [x] Web 端降级可用
- [x] **[00-vision-and-scope.md §4](../00-vision-and-scope.md) 的典型场景能一次交办跑通**（PPT 部分使用旧的降级导出）

## 归档证据

| 门禁 | 结果 |
|---|---|
| `vitest run` | ✅ 48 个测试文件、291 项测试通过；M4/M1 联网 suite 按设计跳过 |
| M4 真实模型验收（历史） | ✅ `deepseek-v4-flash`，2 次 reference 读取、2 轮、4968 tokens；不作为 M4-R 性能门禁 |
| 桌面 GUI Demo | ✅ 热加载、管理页、10 个内置 Skill 与一次性交办人工验收通过 |
| `eslint .` | ✅ 0 错误 0 警告 |
| `tsc -b && vite build` | ✅ 生产构建成功 |
| `cargo test` | ✅ 36 项通过，含 1 万文件压力用例 |
| `git diff --check` | ✅ 通过 |

生产构建仍有既有 Tailwind 选择器、Anthropic SDK browser externalization、动态导入和大 chunk 警告，均不影响退出状态，未由 M4 引入新的阻断项。
