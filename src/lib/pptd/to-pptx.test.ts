import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { exportPptdAsPptx } from './to-pptx'
import { fromPptxBounds, maxBoundsError, toPptxBounds } from './geometry'
import type { PptdProject } from './types'

const project: PptdProject = {
  version: 'v2', title: 'Export', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
  theme: { colors: { bg: '#fff' }, textStyles: {} },
  pages: [{ elements: [
    { elementId: 'text', elementType: 'text', bounds: [10, 20, 300, 40], content: { text: '<p>Hello <strong>bold</strong> <span style="color:#ff0000">red</span></p>' } },
    { elementId: 'chart', elementType: 'chart', bounds: [20, 80, 200, 100], chartType: 'bar' },
  ] }],
}

describe('PPTD export', () => {
  it('keeps page geometry within the 2pt comparison budget', () => {
    const bounds = [10, 20, 300, 40] as const
    expect(maxBoundsError(bounds, fromPptxBounds(toPptxBounds(bounds)))).toBeLessThan(2)
  })

  it('exports locally and reports unsupported element degradations', async () => {
    const result = await exportPptdAsPptx(project)
    expect(result.blob.size).toBeGreaterThan(100)
    expect(result.degradations).toContain('chart: chart rendered as placeholder')
  })

  it('writes one slide per PPTD page with geometry in the PPTX package', async () => {
    const result = await exportPptdAsPptx(project)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const slide = await zip.file('ppt/slides/slide1.xml')?.async('string')
    expect(slide).toContain('<p:sld')
    expect(slide).toContain('<a:xfrm>')
    // PPTD x=10pt maps to 10/96in, then to 95250 EMU in the OOXML package.
    expect(slide).toContain('x="95250"')
    expect(slide).toContain('b="1"')
    expect(slide).toContain('FF0000')
  })
})
