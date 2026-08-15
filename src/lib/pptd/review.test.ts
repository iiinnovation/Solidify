import { describe, expect, it, vi } from 'vitest'
import { parsePptdProject } from './parse'
import { runPptdReviewLoop } from './review'

const project = parsePptdProject({
  manifest: 'version: v2\ntitle: demo\nsize: [960, 540]\npages: [pages/01.page]\n',
  pages: { 'pages/01.page': 'elements: []\n' },
})

describe('PPTD visual review loop', () => {
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
})
