import { describe, expect, it } from 'vitest'
import { validatePptdProject } from './validate'
import type { PptdProject } from './types'

describe('PPTD semantic validation gate', () => {
  it('covers all eight required structural and layout checks', () => {
    const project: PptdProject = {
      version: 'v2', title: 'Invalid', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#777777' }, textStyles: {} },
      pages: [{ elements: [
        { elementId: 'out', elementType: 'shape', bounds: [940, 520, 40, 40], fill: { type: 'solid', color: '#fff' } },
        { elementId: 'hidden', elementType: 'shape', bounds: [430, 130, 40, 40], fill: { type: 'solid', color: '#000' } },
        { elementId: 'cover', elementType: 'shape', bounds: [400, 100, 200, 200], fill: { type: 'solid', color: '#fff' } },
        { elementId: 'first', elementType: 'text', bounds: [40, 40, 60, 15], content: { text: 'This is a very long line that cannot fit inside such a small box', fontSize: 9, color: '#777777' } },
        { elementId: 'second', elementType: 'text', bounds: [50, 45, 50, 15], content: { text: 'overlap', fontSize: 12, color: '$missing' } },
        { elementId: 'image', elementType: 'image', bounds: [40, 300, 200, 120], src: 'media/missing.png' },
      ] }],
      unresolvedTokens: [{ path: 'pages/01.page', token: 'missing' }],
    }
    const result = validatePptdProject(project)
    const errors = result.errors.map((item) => item.code)
    const warnings = result.warnings.map((item) => item.code)
    expect(errors).toEqual(expect.arrayContaining(['out-of-bounds', 'text-overlap', 'missing-media', 'illegible-contrast']))
    expect(warnings).toEqual(expect.arrayContaining(['hidden-element', 'small-font', 'low-contrast', 'text-overflow', 'undefined-token']))
  })

  it('warns only when a later element actually covers an earlier one', () => {
    const base: PptdProject = {
      version: 'v2', title: 'Layers', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ elements: [
        { elementId: 'background', elementType: 'shape', bounds: [0, 0, 400, 300], fill: { type: 'solid', color: '#ffffff' } },
        { elementId: 'foreground', elementType: 'shape', bounds: [20, 20, 40, 40], fill: { type: 'solid', color: '#000000' } },
      ] }],
    }
    expect(validatePptdProject(base).warnings.some((item) => item.code === 'hidden-element')).toBe(false)
    expect(validatePptdProject({ ...base, pages: [{ elements: [...base.pages[0].elements].reverse() }] }).warnings.some((item) => item.code === 'hidden-element')).toBe(true)
  })

  it('flags content pages with fewer than six elements or no non-text evidence structure', () => {
    const sparseText = validatePptdProject({
      version: 'v2', title: 'Sparse', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ pageType: 'content', elements: [
        { elementId: 'title', elementType: 'text', bounds: [40, 40, 800, 50], content: { text: '结论' } },
      ] }],
    })
    const decorativeShape = validatePptdProject({
      version: 'v2', title: 'Sparse', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ pageType: 'content', elements: [
        { elementId: 'title', elementType: 'text', bounds: [40, 40, 800, 50], content: { text: '结论' } },
        { elementId: 'accent', elementType: 'shape', bounds: [40, 120, 8, 100], fill: { type: 'solid', color: '#2563EB' } },
      ] }],
    })
    const structured = validatePptdProject({
      version: 'v2', title: 'Structured', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ pageType: 'content', elements: [
        { elementId: 'accent', elementType: 'shape', bounds: [40, 120, 8, 100], fill: { type: 'solid', color: '#2563EB' } },
        ...Array.from({ length: 5 }, (_, index) => ({
          elementId: `text-${index}`, elementType: 'text' as const,
          bounds: [80 + index * 150, 40 + (index % 2) * 100, 120, 50] as const,
          content: { text: String(index) },
        })),
      ] }],
    })
    expect(sparseText.valid).toBe(true)
    expect(sparseText.warnings).toContainEqual(expect.objectContaining({ code: 'composition-sparse' }))
    expect(decorativeShape.warnings).toContainEqual(expect.objectContaining({ code: 'composition-sparse' }))
    expect(structured.warnings).not.toContainEqual(expect.objectContaining({ code: 'composition-sparse' }))
  })

  it('never infers a token from parsed text and uses a realistic text capacity', () => {
    // Token detection belongs to the parser, which alone can tell `$$USD`
    // (a literal) from `$missing` (a real reference); see parse.test.ts.
    const project: PptdProject = {
      version: 'v2', title: 'Tokens', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ elements: [
        { elementId: 'currency', elementType: 'text', bounds: [20, 20, 400, 100], content: { text: '定价 $USD 100 起' } },
        { elementId: 'escaped', elementType: 'text', bounds: [20, 140, 400, 40], content: { text: '字面量 $missing' } },
      ] }],
    }
    const result = validatePptdProject(project)
    expect(result.errors.some((item) => item.code === 'undefined-token')).toBe(false)
    expect(result.warnings.some((item) => item.code === 'undefined-token')).toBe(false)
    expect(result.warnings.some((item) => item.code === 'text-overflow')).toBe(false)
  })

  it('reports invalid colours instead of treating them as white luminance', () => {
    const result = validatePptdProject({
      version: 'v2', title: 'Colors', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: 'red' }, textStyles: {} }, pages: [{ elements: [] }],
    })
    expect(result.warnings.some((item) => item.code === 'invalid-color')).toBe(true)
  })

  it('checks text contrast against the page background override', () => {
    const result = validatePptdProject({
      version: 'v2', title: 'Dark cover', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#F8FAFC' }, textStyles: {} },
      pages: [{
        background: { color: '#111827' },
        elements: [{
          elementId: 'title', elementType: 'text', bounds: [64, 180, 832, 80],
          content: { text: 'Quarterly review', fontSize: 40, color: '#FFFFFF' },
        }],
      }],
    })

    expect(result.valid).toBe(true)
    expect(result.warnings.some((item) => item.code === 'low-contrast')).toBe(false)
  })

  it('requires image backgrounds to reference bundled media', () => {
    const result = validatePptdProject({
      version: 'v2', title: 'Missing background', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#FFFFFF' }, textStyles: {} },
      pages: [{ background: { type: 'image', src: 'media/missing.png' }, elements: [] }],
    })

    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'missing-media' }))
  })

  it('blocks charts that cannot render meaningful data', () => {
    const result = validatePptdProject({
      version: 'v2', title: 'Chart quality', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#FFFFFF' }, textStyles: {} },
      pages: [{ elements: [{
        elementId: 'architecture-chart', elementType: 'chart', bounds: [40, 40, 880, 400],
        chartType: 'line', data: [{ name: 'SQL 解析' }],
      }] }],
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['chart-insufficient-data', 'chart-no-visible-data']))
  })
})
