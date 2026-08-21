import { describe, expect, it } from 'vitest'
import { bentoGridToBounds, fallbackPlanningDraft } from './bento-layout'
import { parsePlanningDraft, planningPromptBounds } from './planning'
import type { PptdDesignSpec } from './design-resources'

const page = {
  pageType: 'content',
  intent: '增长由核心客户驱动',
  keyPoints: ['收入增长 20%', '续约率提升'],
}

const design: PptdDesignSpec = {
  scenario: 'management-report',
  designSystemId: 'work/report',
  visualSignature: '结论优先',
  palette: { background: '#FFFFFF', surface: '#FFFFFF', text: '#111111', muted: '#666666', accent: '#2563EB', secondary: '#94A3B8' },
  typography: { titleFont: 'Arial', bodyFont: 'Arial', titleSize: 32, bodySize: 18 },
  layout: { margin: 48, columns: 12, gutter: 16 },
  compositionRules: ['结论优先', '证据分组', '保持层级'],
  componentRules: ['卡片有明确用途', '数据直接标注', '避免装饰'],
  prohibited: ['禁止越界', '禁止重叠', '禁止空卡片'],
  imageryStyle: '真实图片',
}

describe('PPTD planning draft', () => {
  it('clamps cards to the 12x6 grid and resolves authored overlap', () => {
    const draft = parsePlanningDraft(JSON.stringify({
      pageType: 'content',
      layoutType: 'bento',
      cards: [
        { id: 'main', grid: { col: -2, row: 0, colSpan: 20, rowSpan: 4 }, type: 'text', priority: 'primary', content: { text: '结论' } },
        { id: 'proof', grid: { col: 0, row: 0, colSpan: 4, rowSpan: 3 }, type: 'data', priority: 'secondary', content: { value: '20%' } },
      ],
    }), page, 0)

    expect(draft.cards[0].grid).toEqual({ col: 0, row: 0, colSpan: 12, rowSpan: 4 })
    expect(draft.cards[1].grid).not.toEqual({ col: 0, row: 0, colSpan: 4, rowSpan: 3 })
    expect(draft.cards.every((card) => card.grid.col + card.grid.colSpan <= 12)).toBe(true)
    expect(draft.cards.every((card) => card.grid.row + card.grid.rowSpan <= 6)).toBe(true)
    expect(draft.cards.every((card, index) => draft.cards.slice(index + 1).every((other) => (
      card.grid.col + card.grid.colSpan <= other.grid.col
      || other.grid.col + other.grid.colSpan <= card.grid.col
      || card.grid.row + card.grid.rowSpan <= other.grid.row
      || other.grid.row + other.grid.rowSpan <= card.grid.row
    )))).toBe(true)
  })

  it('converts grid cells to deterministic in-canvas bounds', () => {
    expect(bentoGridToBounds({ col: 0, row: 0, colSpan: 12, rowSpan: 6 }, design.layout)).toEqual({ x: 48, y: 48, width: 864, height: 444 })
    const draft = parsePlanningDraft(JSON.stringify({
      pageType: 'content', layoutType: 'split',
      cards: [{ id: 'main', grid: { col: 0, row: 0, colSpan: 8, rowSpan: 3 }, type: 'text', priority: 'primary', content: { text: '结论' } }],
    }), page, 0)
    expect(planningPromptBounds(draft, design)).toContain('suggestedBounds')
  })

  it('drops or shrinks cards when an earlier card consumes the whole grid', () => {
    const draft = parsePlanningDraft(JSON.stringify({
      pageType: 'content', layoutType: 'bento',
      cards: [
        { id: 'hero', grid: { col: 0, row: 0, colSpan: 12, rowSpan: 6 }, type: 'text', priority: 'primary', content: { text: '主结论' } },
        { id: 'proof', grid: { col: 0, row: 0, colSpan: 6, rowSpan: 3 }, type: 'data', priority: 'secondary', content: { text: '证据' } },
      ],
    }), page, 0)
    expect(draft.cards).toHaveLength(1)
    expect(draft.cards[0].id).toBe('hero')
  })

  it('uses page-specific deterministic layouts instead of one text-card grid', () => {
    const diagram = fallbackPlanningDraft({
      pageType: 'diagram', intent: '审计 AI 系统架构', keyPoints: ['数据源', '模型服务', '审计应用'],
      visualTask: '三层系统架构和数据流',
    }, 0)
    const chart = fallbackPlanningDraft({
      pageType: 'chart', intent: '风险命中率持续提升', keyPoints: ['Q1 62%', 'Q2 74%'], dataHint: '季度趋势',
    }, 1)
    const cover = fallbackPlanningDraft({ pageType: 'cover', intent: '技术方案', keyPoints: ['审计 AI'] }, 0)
    const firstContent = fallbackPlanningDraft(page, 0)
    const secondContent = fallbackPlanningDraft(page, 1)

    expect(diagram.layoutType).toBe('flow')
    expect(diagram.cards.some((card) => card.type === 'diagram' && card.grid.rowSpan === 5)).toBe(true)
    expect(chart.cards.some((card) => card.type === 'chart')).toBe(true)
    expect(cover.layoutType).toBe('hero')
    expect(firstContent.cards.map((card) => card.grid)).not.toEqual(secondContent.cards.map((card) => card.grid))
    expect(diagram.cards.map((card) => card.grid)).not.toEqual(chart.cards.map((card) => card.grid))
  })

  it('does not require image or chart cards without usable media or numeric evidence', () => {
    const imagePage = {
      pageType: 'content', intent: '产品界面', keyPoints: ['界面说明'], assetBrief: '使用产品截图',
    }
    const chartPage = {
      pageType: 'chart', intent: '趋势持续改善', keyPoints: ['趋势向好', '原因可解释'],
    }

    expect(fallbackPlanningDraft(imagePage, 0).cards.some((card) => card.type === 'image')).toBe(false)
    expect(fallbackPlanningDraft(imagePage, 0, { hasMedia: true }).cards.some((card) => card.type === 'image')).toBe(true)
    expect(fallbackPlanningDraft(chartPage, 0).cards.some((card) => card.type === 'chart')).toBe(false)
  })
})
