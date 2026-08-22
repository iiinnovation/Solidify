# ADR-0014: Skill/Agent 请求链路改进

## 状态

Accepted — 2026-08-22。旧的前置远程分类路径保留为显式回滚开关，不作为默认主路径。

## 决策

- 手选 Skill 直接绑定运行上下文，不注入其他 Skill 索引，也不调用隐藏路由模型。
- 未选 Skill 优先使用高置信本地路由；普通请求由同一 Agent 回合通过 `activate_skill`
  激活，激活后重建工具白名单和资源解析器。
- 上下文由 `context-compiler.ts` 统一编译并在 provider 请求前执行预算门禁。
- 稳定 system/tool/Skill 前缀生成指纹；Anthropic 使用 `cache_control`，OpenAI-compatible
  adapter 使用 `prompt_cache_key`。缓存指标只记录真实 provider 返回值，不把预期收益当实测。
- `run.phase` 是瞬时 UI 事件，不写入持久运行事实；工具进度映射为读取、生成、验证、修复
  等统一阶段。
- 旧 localStorage Skill 数据只通过一次性迁移器写入目录 Skill；迁移失败保留原数据，旧
  store 仅在兼容窗口内可写，迁移成功后降级为只读读取面；迁移仅记录聚合计数和最后状态，
  不记录 Skill 正文或名称。

兼容窗口不会自动关闭。只有迁移 marker、连续干净启动观察和零错误/跳过项同时满足，
显式调用 `finalizeSkillMigrationWindow()` 才会写入 runtime-retired marker；之后旧
`skillV2=false` 覆盖和远程自动路由都不能重新启用。

## 后续退出条件

完成真实多-provider 基准、质量/失败率门禁和迁移遥测后，删除 `skillV2=false`、旧
`src/lib/skills.ts` fallback 及旧 store 写路径。
