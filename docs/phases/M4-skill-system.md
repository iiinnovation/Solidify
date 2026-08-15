# M4 · Skill 体系

| | |
|---|---|
| **层** | L4 |
| **工期** | 2–3 周（约 11–13 pd） |
| **前置** | M2（工具白名单需要权限层）、M3（Skill 存文件系统） |
| **规格** | [specs/skill-format.md](../specs/skill-format.md) |
| **相关决策** | [ADR-0004](../04-decisions.md#adr-0004) |
| **特性开关** | `skillV2` |
| **状态** | ✅ 实现与自动化验收完成（桌面 GUI Demo 待人工演示） |

## 目标

把 Skill 从「一个 prompt 字符串」升级为「一个可安装、可版本化、按需加载的能力包」。

M4 是四根支柱中最后一根落地，完成后 [00-vision-and-scope.md §4](../00-vision-and-scope.md) 的典型场景应该能一次交办跑通。

## Demo（验收标准）

> 把一个 Skill 目录拖进 `~/.solidify/skills/`，命令面板中立刻出现，无需重启。
>
> 唤起它并交办任务，在运行时间线上能看到 AI **主动调用 `read_file`** 去读该 Skill 的 `reference/` 下的详细规范，然后才开始干活。
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
可用参考文档: reference/pptd.md, reference/slide-categories.md, examples/
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

自动化覆盖包括目录热重载、无选择时只注入索引、选中 Skill 后真实 `read_file` 资源读取、工具白名单、三级优先级、显式解析错误和 localStorage 三 Skill 迁移。M4 阶段尚无 M5 的 PPTD Skill，因此用内置 `requirement-analysis` / `presentation` 验证相同的第 2 层读取链路。

真实模型验收使用 DeepSeek-compatible OpenAI 协议端点，不配置或回退到 Anthropic。`npm run test:m4-live` 已验证 `deepseek-v4-flash` 在最终回答前依次读取：

```text
.solidify/skills/requirement-analysis/reference/legacy-guidance.md
.solidify/skills/requirement-analysis/reference/output-format.md
.solidify/skills/requirement-analysis/SKILL.md
```

该次运行共 3 次工具调用、3 轮、7959 tokens。普通测试默认跳过此付费测试，只有显式执行 `test:m4-live` 才会调用真实模型。

## 风险

| 风险 | 应对 |
|---|---|
| 模型不主动读 `reference/` | SKILL.md 正文里显式写"第一步：读取 reference/xxx.md"；在 M4-15 中作为验收用例 |
| 迁移后 Skill 效果不如从前 | 迁移一个验证一个，用同样的输入对比产出；不要 10 个一起改完再测 |
| Web 端降级路径遗漏 | M4-15 中包含 Web 端用例 |
| Skill 目录结构约定与生态不一致 | 采用通用 frontmatter 约定，不自创字段名 |

## 完成定义

- [ ] Demo 能当着人跑通
- [x] [skill-format.md §11](../specs/skill-format.md) 的 7 个用例全部通过
- [ ] 10 个内置 Skill 全部迁移，产出质量不低于迁移前（目录迁移与旧 prompt 完整性已自动校验，10 个 Skill 的逐个模型输出对比尚未执行）
- [x] 未选 Skill 时上下文中的 Skill 索引 < 600 token
- [x] Web 端降级可用
- [ ] **[00-vision-and-scope.md §4](../00-vision-and-scope.md) 的典型场景能一次交办跑通**（PPT 部分可用旧的降级导出）
