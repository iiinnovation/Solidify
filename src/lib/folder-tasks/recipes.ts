import type { FolderTaskPlan, FolderTaskRecipePlan } from './types'

export type FolderTaskRecipeId = 'structured-extraction' | 'document-review' | 'classification'

export interface FolderTaskRecipeContract {
  id: FolderTaskRecipeId
  label: string
  description: string
  resultShape: string
  validateResult: (value: unknown, recipePlan?: FolderTaskRecipePlan) => string[]
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const scalarValue = (value: unknown): value is string | number | boolean =>
  nonEmpty(value) || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean'
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export const FOLDER_TASK_RECIPES: readonly FolderTaskRecipeContract[] = [
  {
    id: 'structured-extraction',
    label: '结构化信息提取',
    description: '逐文件提取摘要、事实与原文证据。',
    resultShape: '{ "summary": string, "facts": [{ "label": string, "value": string|number|boolean, "evidence"?: string }] }',
    validateResult(value, recipePlan) {
      const item = record(value)
      if (!item) return ['结果必须是 JSON 对象']
      const issues = []
      if (!nonEmpty(item.summary)) issues.push('summary 必须是非空字符串')
      if (!Array.isArray(item.facts)) issues.push('facts 必须是数组')
      else {
        for (const [index, fact] of item.facts.entries()) {
          const value = record(fact)
          if (!value || !nonEmpty(value.label) || !scalarValue(value.value)) issues.push(`facts[${index}] 必须包含非空 label 和 string、number 或 boolean 类型的 value`)
          if (value?.evidence !== undefined && !nonEmpty(value.evidence)) issues.push(`facts[${index}].evidence 必须是非空字符串`)
        }
        if (recipePlan?.kind === 'structured-extraction') {
          const fieldsByLabel = new Map(recipePlan.fields.flatMap((field) =>
            [field.name, ...field.aliases].map((label) => [label.toLowerCase(), field] as const),
          ))
          const labels = new Set<string>()
          for (const [index, fact] of item.facts.entries()) {
            const value = record(fact)
            if (!value || !nonEmpty(value.label)) continue
            const field = fieldsByLabel.get(value.label.toLowerCase())
            if (recipePlan.fields.length > 0 && !field) {
              issues.push(`facts[${index}].label 不在已确认字段中`)
              continue
            }
            const canonical = field?.name ?? value.label
            if (labels.has(canonical)) issues.push(`字段 ${canonical} 重复出现`)
            labels.add(canonical)
            if (field?.type === 'string' && !nonEmpty(value.value)) issues.push(`字段 ${field.name} 的 value 必须是非空字符串`)
            if (field?.type === 'number' && (typeof value.value !== 'number' || !Number.isFinite(value.value))) issues.push(`字段 ${field.name} 的 value 必须是有限数字`)
            if (field?.type === 'boolean' && typeof value.value !== 'boolean') issues.push(`字段 ${field.name} 的 value 必须是布尔值`)
          }
          for (const field of recipePlan.fields.filter((field) => field.required)) {
            if (!labels.has(field.name)) issues.push(`缺少必填字段 ${field.name}`)
          }
        }
      }
      return issues
    },
  },
  {
    id: 'document-review',
    label: '批量文档审查',
    description: '逐文件给出发现、严重性和处置建议。',
    resultShape: '{ "summary": string, "findings": [{ "ruleId": string, "severity": "low"|"medium"|"high", "title": string, "description": string, "evidence"?: string }], "recommendation": string }',
    validateResult(value, recipePlan) {
      const item = record(value)
      if (!item) return ['结果必须是 JSON 对象']
      const issues = []
      if (!nonEmpty(item.summary)) issues.push('summary 必须是非空字符串')
      if (!Array.isArray(item.findings)) issues.push('findings 必须是数组')
      else for (const [index, finding] of item.findings.entries()) {
        const value = record(finding)
        if (!value || !['low', 'medium', 'high'].includes(String(value.severity)) || !nonEmpty(value.title) || !nonEmpty(value.description)) {
          issues.push(`findings[${index}] 必须包含合法 severity、title 和 description`)
          continue
        }
        if (recipePlan?.kind === 'document-review') {
          const ruleId = value.ruleId
          if (!nonEmpty(ruleId) || !recipePlan.rules.some((rule) => rule.id === ruleId)) issues.push(`findings[${index}].ruleId 不在已确认规则中`)
          const matchedRule = recipePlan.rules.find((rule) => rule.id === ruleId)
          if (matchedRule?.evidenceRequired && !nonEmpty(value.evidence)) issues.push(`findings[${index}] 对规则 ${matchedRule.id} 必须提供 evidence`)
        }
      }
      if (!nonEmpty(item.recommendation)) issues.push('recommendation 必须是非空字符串')
      return issues
    },
  },
  {
    id: 'classification',
    label: '文件分类与汇总',
    description: '逐文件输出分类、置信度、理由和摘要。',
    resultShape: '{ "summary": string, "category": string, "confidence": number, "rationale": string }',
    validateResult(value, recipePlan) {
      const item = record(value)
      if (!item) return ['结果必须是 JSON 对象']
      const issues = []
      if (!nonEmpty(item.summary)) issues.push('summary 必须是非空字符串')
      if (!nonEmpty(item.category)) issues.push('category 必须是非空字符串')
      if (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1) issues.push('confidence 必须在 0 到 1 之间')
      if (!nonEmpty(item.rationale)) issues.push('rationale 必须是非空字符串')
      if (recipePlan?.kind === 'classification' && nonEmpty(item.category)) {
        const allowed = new Set([...recipePlan.categories.map((category) => category.id), recipePlan.unknownCategory])
        if (!allowed.has(item.category)) issues.push(`category 必须来自已确认分类集合：${[...allowed].join(', ')}`)
        if (typeof item.confidence === 'number' && item.confidence < recipePlan.minimumConfidence && item.category !== recipePlan.unknownCategory) {
          issues.push(`置信度低于 ${recipePlan.minimumConfidence} 时必须使用 ${recipePlan.unknownCategory}`)
        }
      }
      return issues
    },
  },
]

export function getFolderTaskRecipe(recipe: string): FolderTaskRecipeContract | undefined {
  return FOLDER_TASK_RECIPES.find((candidate) => candidate.id === recipe)
}

/** Choose a useful default without asking users to understand execution recipes. */
export function inferFolderTaskRecipe(goal: string): FolderTaskRecipeId {
  const normalized = goal.trim().toLowerCase()
  if (/(分类|归类|分组|标签|整理|classif|categor|tag\b|group\b)/i.test(normalized)) {
    return 'classification'
  }
  if (/(审查|审核|检查|风险|合规|条款|问题|review|audit|risk|compliance)/i.test(normalized)) {
    return 'document-review'
  }
  return 'structured-extraction'
}

export function validateFolderTaskPlanRecipe(plan: FolderTaskPlan): string[] {
  const issues: string[] = []
  if (!getFolderTaskRecipe(plan.recipe)) issues.push(`未知的 Recipe：${plan.recipe}`)
  if (!record(plan.recipePlan)) return [...issues, 'recipePlan 必须是对象']
  if (plan.recipePlan.kind !== plan.recipe) issues.push('recipePlan.kind 必须与 recipe 一致')
  if (plan.recipePlan.schemaVersion !== 1) issues.push('不支持的 RecipePlan schemaVersion')
  if (plan.recipePlan.kind === 'structured-extraction') {
    if (!Array.isArray(plan.recipePlan.fields) || !Array.isArray(plan.recipePlan.dedupeKeys)) return [...issues, '提取计划必须包含 fields 和 dedupeKeys 数组']
    const names = new Set<string>()
    const labels = new Set<string>()
    for (const field of plan.recipePlan.fields) {
      if (!record(field) || !nonEmpty(field.name)) { issues.push('提取字段必须包含非空名称'); continue }
      const name = field.name.toLowerCase()
      if (names.has(name)) issues.push('提取字段名称必须唯一')
      names.add(name)
      if (labels.has(name)) issues.push(`字段或别名存在歧义：${field.name}`)
      labels.add(name)
      if (!nonEmpty(field.description)) issues.push(`字段 ${field.name} 缺少 description`)
      if (!['string', 'number', 'boolean'].includes(String(field.type))) issues.push(`字段 ${field.name} 的 type 无效`)
      if (typeof field.required !== 'boolean') issues.push(`字段 ${field.name} 的 required 必须是布尔值`)
      if (!Array.isArray(field.aliases)) issues.push(`字段 ${field.name} 的 aliases 必须是数组`)
      else for (const alias of field.aliases) {
        if (!nonEmpty(alias)) { issues.push(`字段 ${field.name} 的别名必须是非空字符串`); continue }
        const normalized = alias.toLowerCase()
        if (labels.has(normalized)) issues.push(`字段或别名存在歧义：${alias}`)
        labels.add(normalized)
      }
    }
    for (const key of plan.recipePlan.dedupeKeys) if (!nonEmpty(key) || !names.has(key.toLowerCase())) issues.push(`去重字段不存在：${String(key)}`)
  } else if (plan.recipePlan.kind === 'document-review') {
    if (!Array.isArray(plan.recipePlan.rules)) return [...issues, '审查计划的 rules 必须是数组']
    if (plan.recipePlan.rules.length === 0) issues.push('审查计划至少需要一条规则')
    const ruleIds = plan.recipePlan.rules.map((rule) => record(rule)?.id).filter(nonEmpty)
    if (new Set(ruleIds).size !== ruleIds.length) issues.push('审查规则 ID 必须唯一')
    for (const rule of plan.recipePlan.rules) {
      if (!record(rule) || !nonEmpty(rule.id) || !nonEmpty(rule.title) || !nonEmpty(rule.description)) issues.push('每条审查规则都必须包含 id、title 和 description')
      if (!['low', 'medium', 'high'].includes(String(rule?.severity))) issues.push(`审查规则 ${String(rule?.id)} 的 severity 无效`)
      if (typeof rule?.evidenceRequired !== 'boolean') issues.push(`审查规则 ${String(rule?.id)} 的 evidenceRequired 必须是布尔值`)
    }
  } else if (plan.recipePlan.kind === 'classification') {
    if (!Array.isArray(plan.recipePlan.categories)) return [...issues, '分类计划的 categories 必须是数组']
    if (plan.recipePlan.categories.length < 2) issues.push('分类计划至少需要两个分类')
    const ids = plan.recipePlan.categories.map((category) => record(category)?.id).filter(nonEmpty)
    if (new Set(ids).size !== ids.length) issues.push('分类 ID 必须唯一')
    if (ids.includes(plan.recipePlan.unknownCategory)) issues.push('unknownCategory 不能与普通分类重复')
    for (const category of plan.recipePlan.categories) if (!record(category) || !nonEmpty(category.id) || !nonEmpty(category.label) || !nonEmpty(category.description)) issues.push('每个分类都必须包含 id、label 和 description')
    if (!nonEmpty(plan.recipePlan.unknownCategory)) issues.push('unknownCategory 必须是非空字符串')
    if (typeof plan.recipePlan.minimumConfidence !== 'number' || plan.recipePlan.minimumConfidence < 0 || plan.recipePlan.minimumConfidence > 1) issues.push('minimumConfidence 必须在 0 到 1 之间')
  } else {
    issues.push('未知的 recipePlan.kind')
  }
  return issues
}
