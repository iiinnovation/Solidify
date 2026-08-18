import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { PptdRenderer } from './renderer'
import type { PptdProject } from './types'

const project: PptdProject = {
  version: 'v2', title: 'Demo', size: [960, 540], pagePaths: ['pages/01.page'], media: {},
  theme: { colors: { bg: '#ffffff', accent: '#0b66ff' }, textStyles: { title: { fontSize: 32, color: '#111111', bold: true } } },
  pages: [{ elements: [
    { elementId: 'title', elementType: 'text', bounds: [40, 30, 400, 60], content: { text: '<strong>Hello</strong>', style: 'title' } },
    { elementId: 'box', elementType: 'shape', bounds: [40, 120, 200, 80], shapeName: 'roundRect', fill: { type: 'solid', color: '$accent' } },
  ] }],
}

describe('PptdRenderer', () => {
  it('renders a local page with fixed PPTD coordinates and sanitized rich text', () => {
    render(<PptdRenderer project={project} />)
    const page = document.querySelector('[data-pptd-page="0"]') as HTMLElement
    expect(page).toBeTruthy()
    const title = screen.getByText('Hello').parentElement as HTMLElement
    expect(title.style.left).toBe('40px')
    expect(title.style.top).toBe('30px')
    expect(title.style.width).toBe('400px')
    expect(title.style.height).toBe('60px')
    expect(title.style.fontSize).toBe('32px')
    expect(page.matches('[data-artifact-content]')).toBe(true)
  })

  it('renders parser-expanded theme style tokens', () => {
    const tokenProject: PptdProject = {
      ...project,
      pages: [{ elements: [{
        elementId: 'token-title', elementType: 'text', bounds: [40, 30, 400, 60],
        content: { text: 'Token title', style: { fontSize: 40, color: '#123456', bold: true } },
      }] }],
    }
    render(<PptdRenderer project={tokenProject} />)
    const title = screen.getByText('Token title') as HTMLElement
    expect(title.style.fontSize).toBe('40px')
    expect(title.style.color).toBe('rgb(18, 52, 86)')
    expect(title.style.fontWeight).toBe('700')
  })

  it('reports selected elements without rebuilding the project', () => {
    const onSelect = vi.fn()
    render(<PptdRenderer project={project} onSelectElement={onSelect} />)
    const shape = document.querySelector('[data-artifact-content] > div:nth-child(2)') as HTMLElement
    shape.click()
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ elementId: 'box' }))
  })

  it('scales the fixed canvas to the available panel width without clipping', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 480 })
    vi.stubGlobal('ResizeObserver', class {
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe() { this.callback([], this as unknown as ResizeObserver) }
      disconnect() {}
      unobserve() {}
    })
    try {
      render(<PptdRenderer project={project} />)
      await waitFor(() => expect((document.querySelector('[data-pptd-page="0"]') as HTMLElement).style.transform).toBe('scale(0.5)'))
    } finally {
      vi.unstubAllGlobals()
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'clientWidth', descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth')
    }
  })

  it('sanitizes chart SVG before injecting it into the preview DOM', () => {
    const malicious: PptdProject = {
      ...project,
      pages: [{ elements: [{
        elementId: 'chart', elementType: 'chart', bounds: [20, 20, 320, 180], chartType: 'bar',
        data: [{ name: 'A', value: 1 }],
        series: [{ key: 'value', color: '#fff"/><img src=x onerror="globalThis.__PWNED__=true"><rect fill="' }],
      }] }],
    }
    render(<PptdRenderer project={malicious} />)
    expect(document.querySelector('[data-pptd-chart-type="bar"] img')).toBeNull()
    expect(document.querySelector('[data-pptd-chart-type="bar"] svg')).toBeTruthy()
  })

  it('matches export-facing text and line attributes', () => {
    const parityProject: PptdProject = {
      ...project,
      pages: [{ elements: [
        { elementId: 'text', elementType: 'text', bounds: [20, 20, 300, 100], content: { text: 'a\nb', align: 'center', valign: 'bottom', lineHeightPx: 24 } },
        { elementId: 'line', elementType: 'line', bounds: [100, 100, 2, 200], stroke: { color: '#111111', width: 2 } },
      ] }],
    }
    render(<PptdRenderer project={parityProject} />)
    const text = document.querySelector('[data-artifact-content] > div') as HTMLElement
    expect(text.style.textAlign).toBe('center')
    expect(text.style.lineHeight).toBe('24px')
    expect(text.style.whiteSpace).toBe('pre-wrap')
    expect(text.style.justifyContent).toBe('flex-end')
    const line = document.querySelector('[data-artifact-content] svg line')
    expect(line?.getAttribute('x1')).toBe('0')
    expect(line?.getAttribute('y2')).toBe('100')
  })

  it('falls back from non-hex CSS colours in the preview as well', () => {
    const invalidColorProject: PptdProject = {
      ...project,
      pages: [{ elements: [{ elementId: 'shape', elementType: 'shape', bounds: [20, 20, 80, 40], fill: { type: 'solid', color: 'red' } }] }],
    }
    render(<PptdRenderer project={invalidColorProject} />)
    const shape = document.querySelector('[data-artifact-content] > div') as HTMLElement
    expect(shape.style.background).toBe('rgb(255, 255, 255)')
  })

  it('renders Kimi-compatible image backgrounds, nested table cells, and border-based lines', () => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const compatible: PptdProject = {
      ...project,
      media: { 'media/background.png': image },
      pages: [{
        background: { type: 'image', src: 'media/background.png', fit: { mode: 'cover' } },
        elements: [
          {
            elementId: 'specs', elementType: 'table', bounds: [40, 80, 500, 220],
            columnWidths: [0.3, 0.7], rowHeights: [0.5, 0.5],
            style: { fontSize: 11, bodyColor: '#111111', firstColumnColor: '#666666' },
            rows: [
              [{ content: { text: '传感器', align: ['left', 'middle'] } }, { content: { text: '1 英寸 CMOS' } }],
              [{ content: { text: '视频' } }, { content: { text: '4K/240fps' } }],
            ],
          },
          {
            elementId: 'divider', elementType: 'line', bounds: [40, 320, 500, 1],
            viewBox: [500, 1], points: '0,0.5 500,0.5' as unknown as unknown[],
            border: { color: '#123456', width: 2 },
          },
        ],
      }],
    }

    render(<PptdRenderer project={compatible} />)
    const page = document.querySelector('[data-pptd-page="0"]') as HTMLElement
    expect(page.style.backgroundImage).toContain('data:image/png;base64')
    expect(screen.getByText('传感器')).toBeTruthy()
    expect(screen.getByText('1 英寸 CMOS')).toBeTruthy()
    const columns = document.querySelectorAll('colgroup col')
    expect((columns[0] as HTMLElement).style.width).toBe('30%')
    expect(document.querySelector('svg line')?.getAttribute('stroke')).toBe('#123456')
    expect(document.querySelector('svg line')?.getAttribute('x2')).toBe('500')
  })
})
