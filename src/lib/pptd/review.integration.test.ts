import { describe, expect, it } from 'vitest'
import { runPptdReviewLoop } from './review'
import { validatePptdProject } from './validate'
import type { PptdProject } from './types'

describe('PPTD generation review integration', () => {
  it('feeds a real overlap error back into repair before visual approval', async () => {
    const project: PptdProject = {
      version: 'v2', title: 'Review', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
      theme: { colors: { bg: '#ffffff' }, textStyles: {} },
      pages: [{ elements: [
        { elementId: 'a', elementType: 'text', bounds: [40, 40, 300, 50], content: { text: 'A', fontSize: 20, color: '#111111' } },
        { elementId: 'b', elementType: 'text', bounds: [60, 50, 300, 50], content: { text: 'B', fontSize: 20, color: '#111111' } },
      ] }],
    }
    const result = await runPptdReviewLoop(project, {
      maxRounds: 3,
      validate: validatePptdProject,
      repair: async (current, feedback) => ({
        ...current,
        pages: [{ ...current.pages[0], elements: current.pages[0].elements.map((element) => element.elementId === 'b' ? { ...element, bounds: [60, 120, 300, 50] } : element) }],
        source: { manifestPath: feedback.includes('文本元素重叠') ? 'repaired' : 'unexpected' },
      }),
      capture: async (_current, pageIndexes) => pageIndexes.map((pageIndex) => ({ pageIndex, imageDataUrl: 'data:image/png;base64,preview' })),
      review: async (images) => ({ approved: images.length === 1, feedback: 'APPROVED' }),
    })
    expect(result.approved).toBe(true)
    expect(result.project.source?.manifestPath).toBe('repaired')
    expect(result.feedback[0]).toContain('文本元素重叠')
  })
})
