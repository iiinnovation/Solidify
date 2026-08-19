import { describe, expect, it, vi } from 'vitest'
import { parsePptdProject } from './parse'
import { buildPptdPageSvgDataUrl, buildPptdReviewPrompt, runPptdReviewLoop } from './review'
import type { PptdProject } from './types'

const project = parsePptdProject({
  manifest: 'version: v2\ntitle: demo\nsize: [960, 540]\npages: [pages/01.page]\n',
  pages: { 'pages/01.page': 'elements: []\n' },
})

describe('PPTD visual review loop', () => {
  it('provides a deterministic page self-check prompt', () => {
    expect(buildPptdReviewPrompt(1, 3)).toContain('第 2/3 页')
    expect(buildPptdReviewPrompt(1, 3)).toContain('elementId')
    expect(buildPptdReviewPrompt(1, 3)).toContain('只有标题和少量裸文本')
  })

  it('renders parser-expanded theme styles in visual-review screenshots', () => {
    const styled = parsePptdProject({
      manifest: `version: v2
title: styled
size: [960, 540]
theme:
  colors: {bg: "#ffffff", text: "#123456"}
  textStyles:
    title: {fontSize: 40, color: "$text", bold: true, fontFamily: "Georgia"}
pages: [pages/01.page]
`,
      pages: { 'pages/01.page': `elements:
  - elementId: title
    elementType: text
    bounds: [40, 40, 600, 70]
    content: {text: "Styled title", style: "$title"}
` },
    })
    const svg = decodeURIComponent(buildPptdPageSvgDataUrl(styled, 0).split(',')[1])
    expect(svg).toContain('font-size="40"')
    expect(svg).toContain('font-family="Georgia"')
    expect(svg).toContain('fill="#123456"')
    expect(svg).toContain('font-weight="700"')
  })

  it('renders charts, tables, icons, wrapping, and alignment into review screenshots', () => {
    const visualProject = {
      ...project,
      pages: [{ elements: [
        {
          elementId: 'chart', elementType: 'chart' as const, bounds: [40, 40, 320, 180] as const,
          chartType: 'bar', data: [{ name: 'Q1', value: 10 }, { name: 'Q2', value: 20 }],
          series: [{ key: 'value', color: '#2563EB' }],
        },
        {
          elementId: 'table', elementType: 'table' as const, bounds: [400, 40, 300, 160] as const,
          rows: [['指标', '结果'], ['收入', '增长']], columnWidths: [1, 2],
        },
        { elementId: 'icon', elementType: 'icon' as const, bounds: [720, 40, 60, 60] as const, icon: '★', color: '#D97706' },
        {
          elementId: 'wrapped', elementType: 'text' as const, bounds: [400, 240, 140, 100] as const,
          content: { text: '这是一段需要自动换行的审阅文本', fontSize: 20, align: 'center' },
        },
      ] }],
    }
    const svg = decodeURIComponent(buildPptdPageSvgDataUrl(visualProject, 0).split(',')[1])
    expect(svg).toContain('Q1')
    expect(svg).toContain('指标')
    expect(svg).toContain('★')
    expect(svg).toContain('text-anchor="middle"')
    expect(svg.match(/<tspan/g)?.length).toBeGreaterThan(2)
  })

  it('places line geometry at absolute page coordinates in review screenshots', () => {
    const lineProject: PptdProject = {
      version: 'v2', title: 'lines', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ pageType: 'diagram', elements: [
        {
          elementId: 'edge', elementType: 'line', bounds: [400, 300, 300, 100],
          viewBox: [300, 100], points: '0,50 150,50 150,0 300,0' as unknown as unknown[],
          endArrow: 'triangle', stroke: { color: '#334155', width: 2 },
        },
        { elementId: 'separator', elementType: 'line', bounds: [64, 500, 832, 2], stroke: { color: '#CBD5E1', width: 1 } },
      ] }],
    }
    const svg = decodeURIComponent(buildPptdPageSvgDataUrl(lineProject, 0).split(',')[1])
    expect(svg).toContain('points="400,350 550,350 550,300 700,300"')
    expect(svg).toMatch(/x1="64" y1="501" x2="896" y2="501"/)
  })

  it('repairs validation errors before capture and stops when approved', async () => {
    const order: string[] = []
    const result = await runPptdReviewLoop(project, {
      maxRounds: 2,
      validate: async (_current) => { order.push('validate'); return { errors: order.length === 1 ? [{ path: 'page', message: 'overlap', severity: 'error' }] : [], warnings: [], valid: order.length > 1 } },
      capture: async (_current, pages) => { order.push(`capture:${pages.length}`); return pages.map((pageIndex) => ({ pageIndex, imageDataUrl: 'data:image/png;base64,x' })) },
      review: async () => { order.push('review'); return { approved: true, feedback: '' } },
      repair: async (current) => { order.push('repair'); return current },
    })
    expect(result.approved).toBe(true)
    expect(order).toEqual(['validate', 'repair', 'validate', 'capture:1', 'review'])
  })

  it('stops at validation when the selected model has no vision capability', async () => {
    const validate = vi.fn(async () => ({ errors: [], warnings: [], valid: true }))
    const capture = vi.fn()
    const result = await runPptdReviewLoop(project, {
      visionAvailable: false, validate, capture,
      review: async () => ({ approved: false, feedback: 'unused' }),
      repair: async (current) => current,
    })
    expect(result.approved).toBe(true)
    expect(result.rounds).toBe(0)
    expect(capture).not.toHaveBeenCalled()
    expect(result.feedback[0]).toContain('不支持 vision')
  })

  it('uses the local validator when no adapter override is supplied', async () => {
    const repair = vi.fn(async (current: typeof project) => current)
    const result = await runPptdReviewLoop(project, {
      visionAvailable: false,
      capture: async () => [],
      review: async () => ({ approved: true, feedback: '' }),
      repair,
    })
    expect(result.validation.valid).toBe(true)
    expect(repair).not.toHaveBeenCalled()
  })
})
