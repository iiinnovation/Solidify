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
        { elementId: 'cover', elementType: 'shape', bounds: [400, 100, 200, 200], fill: { type: 'solid', color: '#fff' } },
        { elementId: 'hidden', elementType: 'shape', bounds: [430, 130, 40, 40], fill: { type: 'solid', color: '#000' } },
        { elementId: 'first', elementType: 'text', bounds: [40, 40, 60, 15], content: { text: 'This is a very long line that cannot fit inside such a small box', fontSize: 9, color: '#777777' } },
        { elementId: 'second', elementType: 'text', bounds: [50, 45, 50, 15], content: { text: 'overlap', fontSize: 12, color: '$missing' } },
        { elementId: 'image', elementType: 'image', bounds: [40, 300, 200, 120], src: 'media/missing.png' },
      ] }],
    }
    const result = validatePptdProject(project)
    const errors = result.errors.map((item) => item.code)
    const warnings = result.warnings.map((item) => item.code)
    expect(errors).toEqual(expect.arrayContaining(['out-of-bounds', 'text-overlap', 'missing-media', 'undefined-token']))
    expect(warnings).toEqual(expect.arrayContaining(['hidden-element', 'small-font', 'low-contrast', 'text-overflow']))
  })
})
