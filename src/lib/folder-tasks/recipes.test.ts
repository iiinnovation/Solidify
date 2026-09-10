import { describe, expect, it } from 'vitest'
import { FOLDER_TASK_RECIPES, getFolderTaskRecipe, inferFolderTaskRecipe, validateFolderTaskPlanRecipe } from './recipes'
import type { FolderTaskPlan, FolderTaskRecipePlan } from './types'

describe('FolderTask recipe contracts', () => {
  it('infers the processing recipe from a natural-language goal', () => {
    expect(inferFolderTaskRecipe('把合同按业务部门分类整理')).toBe('classification')
    expect(inferFolderTaskRecipe('审查隐私条款和合规风险')).toBe('document-review')
    expect(inferFolderTaskRecipe('提取合同金额和付款日期')).toBe('structured-extraction')
  })

  it('defines three unique executable recipes', () => {
    expect(FOLDER_TASK_RECIPES.map((recipe) => recipe.id)).toEqual([
      'structured-extraction',
      'document-review',
      'classification',
    ])
  })

  it('validates structured extraction output', () => {
    const recipe = getFolderTaskRecipe('structured-extraction')!
    expect(recipe.validateResult({ summary: 'ok', facts: [] })).toEqual([])
    expect(recipe.validateResult({ summary: 'missing facts' })).toContain('facts 必须是数组')
    const plan = {
      kind: 'structured-extraction', schemaVersion: 1,
      fields: [{ name: 'amount', description: '金额', type: 'number', required: true, aliases: ['金额'] }],
      dedupeKeys: ['amount'],
    } satisfies FolderTaskRecipePlan
    expect(recipe.validateResult({ summary: 'ok', facts: [{ label: '金额', value: 12 }] }, plan)).toEqual([])
    expect(recipe.validateResult({ summary: 'ok', facts: [{ label: '金额', value: '12' }] }, plan)).toContain('字段 amount 的 value 必须是有限数字')
  })

  it('validates document review output', () => {
    const recipe = getFolderTaskRecipe('document-review')!
    expect(recipe.validateResult({ summary: 'ok', findings: [], recommendation: 'accept' })).toEqual([])
    expect(recipe.validateResult({ summary: 'ok', findings: [] })).toContain('recommendation 必须是非空字符串')
    const plan = {
      kind: 'document-review', schemaVersion: 1,
      rules: [{ id: 'privacy', title: '隐私', description: '检查隐私问题', severity: 'high', evidenceRequired: true }],
    } satisfies FolderTaskRecipePlan
    const missingRule = recipe.validateResult({ summary: 'ok', findings: [{ severity: 'high', title: '问题', description: '描述', evidence: '原文' }], recommendation: '修复' }, plan)
    expect(missingRule).toContain('findings[0].ruleId 不在已确认规则中')
  })

  it('bounds classification confidence', () => {
    const recipe = getFolderTaskRecipe('classification')!
    expect(recipe.validateResult({ summary: 'ok', category: 'A', confidence: 0.8, rationale: 'evidence' })).toEqual([])
    expect(recipe.validateResult({ summary: 'ok', category: 'A', confidence: 2, rationale: 'evidence' })).toContain('confidence 必须在 0 到 1 之间')
  })

  it('rejects ambiguous extraction aliases in a confirmed plan', () => {
    const plan = {
      schemaVersion: 3,
      recipe: 'structured-extraction',
      recipePlan: {
        kind: 'structured-extraction', schemaVersion: 1,
        fields: [
          { name: 'amount', description: '金额', type: 'number', required: true, aliases: ['金额'] },
          { name: 'currency', description: '币种', type: 'string', required: false, aliases: ['金额'] },
        ],
        dedupeKeys: ['amount'],
      },
    } as FolderTaskPlan
    expect(validateFolderTaskPlanRecipe(plan)).toContain('字段或别名存在歧义：金额')
  })
})
