import { describe, expect, it } from 'vitest'
import {
  inferPptdScenario,
  PPTD_DESIGN_SYSTEM_IDS,
  resolvePptdDesignSource,
} from './design-resources'

describe('PPTD design resources', () => {
  it('bundles the 30 primary open-kimi-ppt design systems', () => {
    expect(PPTD_DESIGN_SYSTEM_IDS).toHaveLength(30)
    expect(PPTD_DESIGN_SYSTEM_IDS).toContain('consulting/apricot-white-brief')
    expect(PPTD_DESIGN_SYSTEM_IDS).toContain('work/warm-jade-annual-report')
  })

  it.each([
    ['技术架构评审', 'tech-engineering'],
    ['季度经营复盘', 'management-report'],
    ['博士论文答辩', 'academic-research'],
    ['品牌创意提案', 'brand-creative'],
  ] as const)('routes %s to %s guidance', (brief, scenario) => {
    const source = resolvePptdDesignSource(brief)
    expect(inferPptdScenario(brief)).toBe(scenario)
    expect(source.scenario).toBe(scenario)
    expect(source.generalGuidance.length).toBeGreaterThan(1_000)
    expect(source.scenarioGuidance.length).toBeGreaterThan(1_000)
    expect(source.designGuidance.length).toBeGreaterThan(3_000)
  })

  it('honors an explicit design system and rejects unknown ids', () => {
    expect(resolvePptdDesignSource('季度汇报', 'finance/black-gold-ledger').designSystemId)
      .toBe('finance/black-gold-ledger')
    expect(() => resolvePptdDesignSource('季度汇报', 'unknown/theme')).toThrow(/未知 PPTD 设计系统/)
  })

  it.each([
    '战略决策分析',
    '商业计划书',
    '季度经营复盘',
    '博士论文答辩',
    '新员工培训课程',
    '技术架构评审',
    '品牌创意提案',
  ])('provides a concrete layout example for %s', (brief) => {
    expect(resolvePptdDesignSource(brief).examplePage).toMatch(/pageType:/)
  })
})
