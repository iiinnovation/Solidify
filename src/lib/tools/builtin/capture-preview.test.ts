import { describe, expect, it } from 'vitest'
import { selectPreviewElement } from './capture-preview'

describe('selectPreviewElement', () => {
  it('selects a PPTD page whether the root is the page or a project wrapper', () => {
    document.body.innerHTML = '<div id="root"><div data-pptd-page="0"></div><div data-pptd-page="1"></div></div>'
    const root = document.querySelector('#root') as HTMLElement
    expect(selectPreviewElement(root, 1)?.getAttribute('data-pptd-page')).toBe('1')
    expect(selectPreviewElement(root, 2)).toBeNull()
    expect(selectPreviewElement(root.querySelector('[data-pptd-page="1"]') as HTMLElement, 1)?.getAttribute('data-pptd-page')).toBe('1')
  })
})
