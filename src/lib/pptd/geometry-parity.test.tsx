import JSZip from 'jszip'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PptdRenderer } from './renderer'
import { exportPptdAsPptx } from './to-pptx'
import { maxBoundsError } from './geometry'
import type { PptdBounds, PptdProject } from './types'

const project: PptdProject = {
  version: 'v2', title: 'Parity', size: [960, 540], pagePaths: ['pages/01.page', 'pages/02.page'], media: {},
  theme: { colors: { bg: '#ffffff' }, textStyles: {} },
  pages: [
    { elements: [
      { elementId: 'text', elementType: 'text', bounds: [48, 42, 320, 56], content: { text: 'Text' } },
      { elementId: 'shape', elementType: 'shape', bounds: [80, 140, 220, 90], shapeName: 'rect', fill: { type: 'solid', color: '#2563eb' } },
    ] },
    { elements: [
      { elementId: 'line', elementType: 'line', bounds: [100, 100, 500, 10], stroke: { color: '#111111', width: 2 } },
      { elementId: 'label', elementType: 'text', bounds: [120, 180, 260, 44], content: { text: 'Page 2' } },
    ] },
  ],
}

describe('PPTD preview/export geometry parity', () => {
  it('keeps every page element within 2pt between rendered DOM and exported OOXML', async () => {
    const result = await exportPptdAsPptx(project)
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    for (const [pageIndex, page] of project.pages.entries()) {
      const view = render(<PptdRenderer project={project} pageIndex={pageIndex} />)
      const preview = Array.from(view.container.querySelectorAll<HTMLElement>('[data-artifact-content] > *')).map((element) => [
        Number.parseFloat(element.style.left), Number.parseFloat(element.style.top), Number.parseFloat(element.style.width), Number.parseFloat(element.style.height),
      ] as PptdBounds)
      const xml = await zip.file(`ppt/slides/slide${pageIndex + 1}.xml`)?.async('string') ?? ''
      const exported = extractBounds(xml)
      expect(exported).toHaveLength(page.elements.length)
      preview.forEach((bounds, index) => expect(maxBoundsError(bounds, exported[index])).toBeLessThan(2))
      view.unmount()
    }
  })
})

function extractBounds(xml: string): PptdBounds[] {
  const result: PptdBounds[] = []
  const pattern = /<a:xfrm[^>]*>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"\/>[\s\S]*?<\/a:xfrm>/g
  for (const match of xml.matchAll(pattern)) {
    const bounds = [Number(match[1]) / 9525, Number(match[2]) / 9525, Number(match[3]) / 9525, Number(match[4]) / 9525] as const
    if (bounds[2] > 0 && bounds[3] > 0) result.push(bounds)
  }
  return result
}
