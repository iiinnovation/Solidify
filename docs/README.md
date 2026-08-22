# Solidify 产品与架构文档

Solidify 的目标形态：**本地优先的 AI 交付工作台** —— 由文件管理、项目作业区、Skill 体系、Agent 协作四根支柱构成。

本目录记录从当前形态（AI 对话 + Artifact 生成）演进到目标形态的完整设计与分阶段任务。

---

## 阅读顺序

新加入的同学按此顺序读，约 40 分钟：

| # | 文档 | 内容 | 读完你会知道 |
|---|---|---|---|
| 0 | [00-vision-and-scope.md](00-vision-and-scope.md) | 产品定位、四支柱、非目标 | 我们要做成什么 |
| 1 | [01-current-state.md](01-current-state.md) | 代码实测盘点、差距矩阵、已知缺陷 | 我们现在在哪 |
| 2 | [02-target-architecture.md](02-target-architecture.md) | 五层架构、模块划分、数据流 | 要长成什么骨架 |
| 3 | [03-roadmap.md](03-roadmap.md) | M1–M6 里程碑、依赖、排期 | 按什么顺序做 |
| 4 | [04-decisions.md](04-decisions.md) | ADR 架构决策记录 | 为什么这么选 |

## 规格文档（写代码前必读对应项）

| 文档 | 约束的模块 | 对应里程碑 |
|---|---|---|
| [specs/agent-loop.md](specs/agent-loop.md) | 查询引擎、流式管线、中断与恢复 | M1 |
| [specs/tool-interface.md](specs/tool-interface.md) | Tool 接口、注册表、执行上下文 | M1 |
| [specs/harness.md](specs/harness.md) | Hook 系统、权限策略、特性开关、运行账本 | M2 |
| [specs/workspace-format.md](specs/workspace-format.md) | 工作区目录格式、本地索引 | M3 |
| [specs/skill-format.md](specs/skill-format.md) | SKILL.md 规范、渐进式披露 | M4 |
| [specs/pptd-subset.md](specs/pptd-subset.md) | PPTD 支持范围与导出映射 | M5 |

## 阶段任务清单

| 里程碑 | 主题 | 工期 |
|---|---|---|
| [M1](phases/M1-agent-runtime.md) | AI 交互引擎与工具系统 | 4–5 周 |
| [M2](phases/M2-harness.md) | Harness 安全与控制平面 | 2–3 周 |
| [M3](phases/M3-local-workspace.md) | 本地工作区与记忆 | 3–4 周 |
| [M3.5](phases/M3.5-unified-workspace-ui.md) | 统一工作台与交付物模型 | 2–3 周 |
| [M4](phases/M4-skill-system.md) | Skill 体系 | 2–3 周 |
| [M5](phases/M5-pptd-engine.md) | PPTD 演示文稿引擎 | 5–7 周 |
| [M6](phases/M6-multi-agent.md) | 多 Agent 协作 | 4–5 周 |

M6 后的候选方向与触发条件见 [05-post-m6-evaluation.md](05-post-m6-evaluation.md)，不属于当前正式里程碑排期。

## 参考资料

[reference/](reference/) 下是一套生产级 Agent Runtime 框架的脱敏架构提取，是本项目 L1–L5 分层设计的直接来源：

- [core_architecture_overview.md](reference/core_architecture_overview.md) — 五层体系与工程原则
- [core_tech_extraction.md](reference/core_tech_extraction.md) — 各层技术细节与伪代码
- [harness_engineering.md](reference/harness_engineering.md) — Hook 系统与安全控制平面
- [extensibility_hooks_plugins.md](reference/extensibility_hooks_plugins.md) — 插件与钩子
- [memory_state_management.md](reference/memory_state_management.md) — 记忆与状态
- [implementation_recommendations.md](reference/implementation_recommendations.md) — 采纳顺序建议

⚠️ 这些是**模式参考**，不是可直接复制的实现。落地时用自己的类型和命名，不要照搬其中的专有结构。

## 专项改进建议

- [Skill / Agent 请求链路改进建议](skill-agent-pipeline-improvement-proposal.md) — Skill 路由、上下文、附件、工具、Prompt Cache、旧代码退役与分阶段验收方案
- [ADR-0014 Skill/Agent 请求链路改进](adr/0014-skill-agent-pipeline.md) — 当前运行时激活、上下文编译、缓存和迁移边界

---

## 文档约定

- **任务编号**：`M<里程碑>-<序号>`，如 `M1-03`。代码提交信息带上编号。
- **估时单位**：人日（pd）。一人一天 = 1pd。
- **状态标记**：`⬜ 未开始` / `🔄 进行中` / `✅ 已完成` / `⏸️ 挂起` / `❌ 取消`
- **代码引用**：一律用 `文件路径:行号`，便于点击跳转。
- 架构决策变更走 [04-decisions.md](04-decisions.md) 追加新 ADR，**不修改已接受的 ADR**，用「取代」标记。

*最后更新：2026-08-11*
