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
})
