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

  it('keeps title and section slides on the primary background behind white text', () => {
    const project = legacyToPptd({ slides: [
      { layout: 'title', title: 'Cover' },
      { layout: 'section', title: 'Section' },
      { layout: 'content', title: 'Content', body: ['line'] },
    ] })
    expect(project.pages[0]?.background?.color).toBe('#D4915E')
    expect(project.pages[1]?.background?.color).toBe('#D4915E')
    expect(project.pages[2]?.background?.color).toBe('#FFFDF9')
    expect(project.pages[2]?.elements.find((element) => element.elementId.endsWith('-body'))?.content?.whiteSpace).toBe('pre-wrap')
  })

  it('keeps a dense timeline free of overlapping rows so it stays exportable', () => {
    for (const count of [9, 10, 20, 40]) {
      const project = legacyToPptd({ slides: [{
        layout: 'timeline',
        title: 'Roadmap',
        items: Array.from({ length: count }, (_item, index) => ({ time: `T${index}`, text: `事件 ${index}` })),
      }] })
      const overlaps = validatePptdProject(project).errors.filter((item) => item.code === 'text-overlap')
      expect(overlaps, `${count} 条时间线`).toEqual([])
    }
  })
})
