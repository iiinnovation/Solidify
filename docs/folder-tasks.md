# FolderTask runtime (V3)

FolderTask 是桌面端的大文件夹批处理运行时。Conversation 只是交互和 Agent 执行界面；SQLite 中的任务、计划、文件快照、批次和检查点才是事实源。

V3 借鉴表格采集流水线的核心分层：先固化可验证计划，再做受限采集，最后由本地确定性处理器生成交付物。模型负责理解文件，不负责决定任务范围、恢复语义、去重或写文件。

## 对话优先的用户流程

用户只需描述目标，然后选择多份文档或整个文档文件夹。多文档模式会持久化最初选择的相对路径，后续刷新不会把同目录下未选择的文件扩进任务。Conversation 中的 LLM 根据自然语言生成具体的提取字段、审查规则或分类，使用推荐执行参数完成 plan preview/confirmation，并在同一轮开始处理。批次大小、快照、资源预算、输出路径等执行器参数默认隐藏在“高级设置”中。

无法由内置解析器可靠读取的格式属于技术兼容性问题：默认记录清单并跳过，不再进入“人工复核”。`manual_review` 只保留给已经产生 AI 结果、但需要用户确认或修正的场景。业务歧义由 Agent 在对话中提出一个合并问题；用户自然语言回复后，Agent 使用 `resolve_folder_task_decision` 将回答映射到已提供的选项并继续任务。

## 生命周期与计划确认

```text
awaiting_plan_confirmation
  -> running
  -> awaiting_decision -> running
  -> reviewing
  -> completed

running <-> paused
active -> failed | cancelled
```

新任务扫描后和详情页的推荐启动均进入对话，由 Agent 根据目标生成语义计划并完成两阶段确认；推荐入口不会直接绑定后端默认计划。旧任务或高级模式仍可手动执行：

1. `preview_folder_task_plan` 校验完整 `FolderTaskPlan`，计算纳入/排除范围，并持久化预览。
2. `confirm_folder_task_plan` 只接受预览返回的 confirmation token。token 由 task ID、完整计划 JSON 和 inventory fingerprint 共同生成，因此任何计划或文件快照变化都会使旧预览失效。

`refresh_before_run` 会在确认时重新扫描。如果 fingerprint 改变，后端保存新 inventory、撤销旧预览并要求用户重新确认，不会在旧授权上继续运行。

## 版本化执行契约

`FolderTaskPlan.schemaVersion = 3`，由以下部分组成：

- `RecipePlan`：结构化提取字段/类型/必填项/去重键，文档审查规则和证据要求，或分类集合与最低置信度。
- `snapshotMode`：使用当前 SHA-256 快照，或确认前刷新。
- `completionPolicy`：处理完成后确认 AI 结果，或无异常时自动完成。
- `ResourceLimits`：批次字节与预计字符预算，以及单文件字符、PDF 页数、ZIP 条目数和展开字节上限。
- `OutputPlan`：JSON/XLSX、任务根目录内的相对路径、是否覆盖以及是否自动写入。

旧版 `outputMode`/`baselineMode` 会在数据库迁移时映射到明确的新字段；未来 schema 版本会被拒绝，而不是静默降级。

Recipe 结果在 TypeScript IPC 前和 Rust 持久化前各校验一次。提取值必须符合已确认字段类型；审查 finding 必须引用已确认的 `ruleId`，并遵守证据要求；低于阈值的分类只能落入 unknown category。

## Inventory 与文件边界

扫描有硬上限：20,000 个目录条目、10,000 个文件、32 层目录、2 GiB 总量、25 MiB 单文件。触发限制时 inventory 会设置 `truncated` 和具体原因，不能把不完整扫描误认为完整输入。单个文件无法读取或计算哈希时记录告警并跳过，不中止整个扫描。

每个纳入文件保存相对路径、大小、mtime、SHA-256、预计字符数和 parser provenance；inventory fingerprint 按排序后的文件路径与内容哈希计算。读取时 Rust 再验证：

- 路径仍在 canonical task root 内；
- 文件属于当前 run 独占的 active batch；
- size、mtime 和 SHA-256 均与 inventory 一致；
- 每次成功读取都会续租 batch lease。

文本、JSON/XML/YAML/日志、DOCX、XLSX 和文本型 PDF 在本地解析。解析器返回 `parsed`、`truncated`、`unsupported` 或 `failed`，失败不会伪装成文件正文。DOCX/XLSX 在解压前检查 ZIP 条目和展开大小，PDF 与所有文本输出受字符/页数上限约束。

## 批次、检查点与恢复

每个 Agent turn 是一个有界 run，只能领取一个 batch。claim 同时满足计划的文件数、原始字节数和预计字符数预算；即使首个文件超过预算，也会单独领取，避免任务永久饥饿。

batch token 是读取、决策和 checkpoint 的能力凭证。完整 checkpoint 必须恰好交代该批次所有仍在处理的文件；中断 checkpoint 会保留已完成结果并把未处理项回队。暂停、取消、run 异常、lease 到期和应用恢复都不会遗失 processing 项。非 owner run 的失败不能把另一个 run 正在持有的任务误标为失败。

自动运行以 `taskId` 为唯一调度键：同一任务最多一个 conversation 拥有 auto-run，防止多个聊天窗口竞争同一任务。

## 确定性输出

输出由 Rust 后端生成，不再依赖前端下载临时 JSON：

- 固定按相对路径排序；
- 结构化提取按已确认 `dedupeKeys` 去重，并合并 source provenance；
- 汇总状态、分类和严重性；
- JSON 包含计划、inventory、记录、逐项结果和哈希 provenance；
- XLSX 固定生成 `Summary`、`Results`、`Failures` 三张表。

结果页以字段卡片呈现摘要、提取值、审查发现和依据，并提供保持数据类型的表单修正。XLSX 将提取字段及依据拆列，分类、置信度、审查发现和建议独立展示。已完成任务允许修正，保存后重新进入待确认状态；重试操作会重新启动任务对话。列表轮询保留筛选和已加载范围，进度文案区分成功与跳过数量。

写入路径必须位于任务根目录内，且不能覆盖 inventory 中的源文件。内容先写同目录临时文件并同步到磁盘；替换已有输出时保留可恢复备份直到新文件就位。每次成功输出保存 SHA-256 和记录数，重复生成相同内容是幂等的。即使计划未授权覆盖，只要磁盘现有文件的 SHA-256 与数据库记录的上一版任务输出一致，结果修正后也可安全替换；用户或外部程序修改过的输出仍会拒绝覆盖。自动写入发生在最后一个 checkpoint 和结果修正后；若文件已写入但数据库事务随后失败，重试会通过相同内容哈希收敛。

## 能力隔离与 UI

普通聊天不会获得 FolderTask 工具。任务对话只暴露专用的 context、plan、claim、read、checkpoint、decision、result-list、result-review、output 能力；临时附件、通用文件系统工具、知识检索和子 Agent 不会继承 batch lease。语义计划生成、业务问题回答、结果查询与修正、重试、输出刷新和最终确认都可以留在 Conversation 内完成。完成工具还会校验最近一条用户消息包含明确确认，不能仅凭模型自行判断结束任务。

`/folder-tasks` 默认展示任务摘要、AI 结果和技术异常；完整计划、范围预览、资源预算与输出策略收进高级设置。用户只能修正已经存在的 AI 结果，不能通过“人工审核”替代不可解析文件的模型处理；修正后仍需通过同一 RecipePlan 校验才能保存。

## 验证边界

本地测试覆盖计划 token、SHA 内容变化、自适应批次、lease/owner 隔离、恢复、结果契约和确定性 XLSX 输出。真实 OpenAI、Anthropic 或内部 Qwen provider 的流式 tool-call、限流和凭据兼容仍属于单独的联网验收矩阵；本地测试不会静默调用真实 provider。
