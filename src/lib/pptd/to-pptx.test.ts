import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { exportPptdAsPptx } from './to-pptx'
import { fromPptxBounds, maxBoundsError, toPptxBounds } from './geometry'
import { PPTD_IMAGE_CHART_TYPES, PPTD_NATIVE_CHART_TYPES } from './chart'
import type { PptdProject } from './types'

const project: PptdProject = {
  version: 'v2', title: 'Export', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
  theme: { colors: { bg: '#fff' }, textStyles: {} },
  pages: [{ elements: [
    { elementId: 'text', elementType: 'text', bounds: [10, 20, 300, 60], content: { text: '<p>Hello <strong>bold</strong> <span style="color:#ff0000">red</span></p><p>Second line</p>' } },
    { elementId: 'overlay', elementType: 'shape', bounds: [10, 85, 300, 10], shapeName: 'rect', fill: { type: 'solid', color: '#0C0C0E59' } },
    { elementId: 'chart', elementType: 'chart', bounds: [20, 80, 200, 100], chartType: 'bar', data: [{ name: 'A', value: 3 }, { name: 'B', value: 5 }] },
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
    expect(result.degradations).toEqual([])
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
    expect(slide).toContain('</a:p><a:p>')
    expect(slide).toContain('<a:alpha val="35000"')
  })

  it('embeds non-native charts as images and reports the degradation', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      pages: [{ elements: [{ elementId: 'flow', elementType: 'chart', bounds: [20, 40, 400, 220], chartType: 'sankey', data: [{ name: 'A', value: 3 }, { name: 'B', value: 5 }] }] }],
    })
    expect(result.report.count).toBe(1)
    expect(result.report.summary).toContain('静态图片')
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/media/'))).toBe(true)
  })

  it.each(PPTD_NATIVE_CHART_TYPES)('exports %s as an editable native chart', async (chartType) => {
    const result = await exportPptdAsPptx(chartProject(chartType))
    expect(result.report.count).toBe(0)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/charts/chart'))).toBe(true)
  })

  it.each(PPTD_IMAGE_CHART_TYPES)('exports %s as an embedded static image with a report', async (chartType) => {
    const result = await exportPptdAsPptx(chartProject(chartType))
    expect(result.report.summary).toContain(chartType)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).some((path) => path.startsWith('ppt/media/'))).toBe(true)
  })

  it('drops unsupported animations visibly in the degradation report', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      pages: [{ animations: [{ type: 'fade' }], elements: [{ elementId: 'animated', elementType: 'text', bounds: [20, 20, 200, 40], content: { text: 'Animated' }, animation: { type: 'fly-in' } }] }],
    })
    expect(result.report.summary).toContain('动画已丢弃')
    expect(result.report.count).toBe(2)
  })
})

function chartProject(chartType: string): PptdProject {
  return {
    ...project,
    pages: [{ elements: [{ elementId: chartType, elementType: 'chart', bounds: [20, 40, 400, 220], chartType, data: [{ name: 'A', value: 3, open: 2, close: 3, high: 4, low: 1, size: 5 }, { name: 'B', value: 5, open: 5, close: 4, high: 6, low: 3, size: 8 }] }] }],
  }
}
