import { describe, expect, it } from 'vitest'
import { assemblePptdProject } from './assemble'
import type { PptdPage, PptdTheme } from './types'

const theme: PptdTheme = { colors: { bg: '#ffffff' }, textStyles: {} }

describe('PPTD project assembly', () => {
  it('assembles pages with stable canonical paths and validates the project', () => {
    const pages: PptdPage[] = [
      { elements: [{ elementId: 'title', elementType: 'text', bounds: [40, 40, 400, 80], content: { text: 'Title', fontSize: 32 } }] },
      { elements: [] },
    ]

    const result = assemblePptdProject({ title: 'Deck', theme, pages })

    expect(result.project).toMatchObject({
      version: 'v2',
      title: 'Deck',
      size: [960, 540],
      pagePaths: ['pages/01.page', 'pages/02.page'],
    })
    expect(result.validation.valid).toBe(true)
    expect(result.pageResults.map((page) => page.valid)).toEqual([true, true])
  })

  it('groups diagnostics by exact page path for targeted repair', () => {
    const result = assemblePptdProject({
      title: 'Broken deck',
      theme,
      pages: [
        { elements: [{ elementId: 'outside', elementType: 'shape', bounds: [950, 0, 20, 20] }] },
        { elements: [
          { elementId: 'a', elementType: 'text', bounds: [0, 0, 100, 40], content: { text: 'A' } },
          { elementId: 'b', elementType: 'text', bounds: [10, 10, 100, 40], content: { text: 'B' } },
        ] },
      ],
    })

    expect(result.validation.valid).toBe(false)
    expect(result.pageResults[0].errors.map((item) => item.code)).toEqual(['out-of-bounds'])
    expect(result.pageResults[1].errors.map((item) => item.code)).toEqual(['text-overlap'])
    expect(result.projectErrors).toEqual([])
  })

  it('keeps project-level diagnostics separate and rejects ambiguous paths', () => {
    const empty = assemblePptdProject({ title: 'Empty', theme, pages: [] })
    expect(empty.projectErrors.map((item) => item.code)).toEqual(['empty-pages'])

    expect(() => assemblePptdProject({
      title: 'Mismatch',
      theme,
      pages: [{ elements: [] }],
      pagePaths: [],
    })).toThrow(/must match pages length/)

    expect(() => assemblePptdProject({
      title: 'Unsafe',
      theme,
      pages: [{ elements: [] }],
      pagePaths: ['../page.page'],
    })).toThrow(/safe relative paths/)
  })
})
