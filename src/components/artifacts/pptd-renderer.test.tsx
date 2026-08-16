import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PresentationArtifactRenderer } from './pptd-renderer'

const pptd = `version: v2
title: Inline deck
size: [960, 540]
theme: {colors: {bg: '#fff', text: '#111'}, textStyles: {}}
pages:
  - elements:
      - elementId: first
        elementType: text
        bounds: [40, 40, 400, 50]
        content: {text: First page, fontSize: 24}
  - elements:
      - elementId: second
        elementType: text
        bounds: [40, 40, 400, 50]
        content: {text: Second page, fontSize: 24}
`

describe('PresentationArtifactRenderer', () => {
  it('renders and navigates a self-contained PPTD artifact', () => {
    render(<PresentationArtifactRenderer content={pptd} />)
    expect(screen.getByText('First page')).toBeTruthy()
    expect(document.querySelector('[data-pptd-page="1"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('Second page')).toBeTruthy()
    expect(document.querySelector('[data-pptd-artifact="Inline deck"]')).toBeTruthy()
  })

  it('keeps legacy slides on the compatibility renderer', () => {
    render(<PresentationArtifactRenderer content={JSON.stringify({ slides: [{ layout: 'title', title: 'Legacy title' }] })} />)
    expect(screen.getByText('Legacy title')).toBeTruthy()
  })
})
