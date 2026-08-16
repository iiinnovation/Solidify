import { describe, expect, it } from 'vitest'
import { legacyToPptd } from './migrate-legacy'
import { validatePptdProject } from './validate'
import type { SlidesDeck } from '@/lib/slide-types'

const layouts = ['title', 'content', 'two-column', 'image-text', 'comparison', 'stats', 'timeline', 'section'] as const

describe('legacy slide migration', () => {
  it('maps all eight legacy layouts into valid PPTD pages', () => {
    const deck: SlidesDeck = { slides: layouts.map((layout) => ({
      layout, title: `${layout} title`, subtitle: 'subtitle', body: ['one', 'two'], left: ['left'], right: ['right'], leftTitle: 'L', rightTitle: 'R', image: 'image', stats: [{ label: 'A', value: '1' }], items: [{ time: 'T1', text: 'Event' }], notes: 'notes',
    })) }
    const project = legacyToPptd(deck, 'Migrated')
    expect(project.pages).toHaveLength(8)
    expect(validatePptdProject(project).errors).toEqual([])
    expect(project.pages.every((page) => page.elements.length > 0)).toBe(true)
  })
})
