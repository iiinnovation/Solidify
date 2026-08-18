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

  it('exports parser-expanded theme style tokens with their typography', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      theme: { ...project.theme, textStyles: { title: { fontSize: 40, fontFamily: 'Georgia', color: '#123456', bold: true } } },
      pages: [{ elements: [{
        elementId: 'styled', elementType: 'text', bounds: [20, 20, 400, 80],
        content: { text: 'Styled', style: { fontSize: 40, fontFamily: 'Georgia', color: '#123456', bold: true } },
      }] }],
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const slide = await zip.file('ppt/slides/slide1.xml')?.async('string') ?? ''
    expect(slide).toContain('sz="4000"')
    expect(slide).toContain('123456')
    expect(slide).toContain('b="1"')
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

  it('falls back from non-hex colours and records each degradation', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      pages: [{ elements: [
        { elementId: 'bad-fill', elementType: 'shape', bounds: [20, 20, 120, 60], fill: { type: 'solid', color: 'red' } },
        { elementId: 'bad-text', elementType: 'text', bounds: [20, 90, 200, 40], content: { text: 'Fallback', color: 'rgb(37,99,235)' } },
      ] }],
    })
    expect(result.report.summary).toContain('颜色')
    expect(result.degradations.some((message) => message.includes('RRREED'))).toBe(false)
  })

  it('converts lineHeightPx from CSS pixels to PowerPoint points', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      pages: [{ elements: [{ elementId: 'lh', elementType: 'text', bounds: [20, 20, 300, 100], content: { text: 'one\ntwo', lineHeightPx: 24 } }] }],
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const slide = await zip.file('ppt/slides/slide1.xml')?.async('string') ?? ''
    expect(slide).toContain('spcPts')
    expect(slide).toContain('val="1800"')
  })

  it('blocks the export only when there is nothing worth writing', async () => {
    await expect(exportPptdAsPptx({ ...project, pages: [], pagePaths: [] }))
      .rejects.toThrow('PPTD 校验失败')
  })

  it('still exports an imperfect layout and reports the diagnostics instead', async () => {
    const result = await exportPptdAsPptx({
      ...project,
      pages: [{ elements: [
        { elementId: 'out', elementType: 'shape', bounds: [950, 530, 30, 30], fill: { type: 'solid', color: '#ffffff' } },
        { elementId: 'a', elementType: 'text', bounds: [40, 40, 300, 60], content: { text: 'A' } },
        { elementId: 'b', elementType: 'text', bounds: [60, 60, 300, 60], content: { text: 'B' } },
      ] }],
    })

    expect(result.blob.size).toBeGreaterThan(0)
    expect(result.degradations.some((message) => message.includes('超出画布边界'))).toBe(true)
    expect(result.degradations.some((message) => message.includes('文本元素重叠'))).toBe(true)
    expect(result.report.count).toBeGreaterThan(0)
  })

  it('embeds image backgrounds and preserves Kimi-style nested table content', async () => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const result = await exportPptdAsPptx({
      ...project,
      media: { 'media/background.png': image, 'media/product.png': image },
      pages: [{
        background: { type: 'image', src: 'media/background.png', fit: { mode: 'cover' } },
        elements: [
          { elementId: 'product', elementType: 'image', bounds: [620, 80, 280, 180], src: 'media/product.png', fit: { mode: 'cover' } },
          {
            elementId: 'specs', elementType: 'table', bounds: [40, 80, 520, 300],
            columnWidths: [0.3, 0.7], rowHeights: [0.5, 0.5], style: { fontSize: 11 },
            rows: [
              [{ content: { text: '传感器' } }, { content: { text: '1 英寸 CMOS' } }],
              [{ content: { text: '视频' } }, { content: { text: '4K/240fps' } }],
            ],
          },
        ],
      }],
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const slide = await zip.file('ppt/slides/slide1.xml')?.async('string') ?? ''

    expect(Object.keys(zip.files).filter((path) => path.startsWith('ppt/media/')).length).toBeGreaterThanOrEqual(2)
    expect(slide).toContain('传感器')
    expect(slide).toContain('1 英寸 CMOS')
    expect(slide).toContain('<a:srcRect')
    expect(result.degradations).toEqual([])
  })
})

function chartProject(chartType: string): PptdProject {
  return {
    ...project,
    pages: [{ elements: [{ elementId: chartType, elementType: 'chart', bounds: [20, 40, 400, 220], chartType, data: [{ name: 'A', value: 3, open: 2, close: 3, high: 4, low: 1, size: 5 }, { name: 'B', value: 5, open: 5, close: 4, high: 6, low: 3, size: 8 }] }] }],
  }
}
