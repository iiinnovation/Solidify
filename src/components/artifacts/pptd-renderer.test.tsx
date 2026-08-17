import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { RunLedger } from '@/lib/harness/ledger'
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
  beforeEach(() => localStorage.clear())

  it('renders and navigates a self-contained PPTD artifact', () => {
    render(<PresentationArtifactRenderer content={pptd} />)
    expect(screen.getByText('First page')).toBeTruthy()
    expect(document.querySelector('[data-pptd-page="1"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(screen.getByText('Second page')).toBeTruthy()
    expect(document.querySelector('[data-pptd-artifact="Inline deck"]')).toBeTruthy()
  })

  it('migrates legacy slides onto the PPTD renderer', () => {
    render(<PresentationArtifactRenderer content={JSON.stringify({ slides: [{ layout: 'title', title: 'Legacy title' }] })} />)
    expect(screen.getByText('Legacy title')).toBeTruthy()
    expect(document.querySelector('[data-pptd-artifact="Migrated presentation"]')).toBeTruthy()
  })

  it('shows actionable diagnostics and records a deduplicated ledger event', async () => {
    const invalid = '{\n  "slides": [{"layout":"title","title":"Bad",}]\n}'
    const view = render(<PresentationArtifactRenderer content={invalid} artifactId="deck-1" runId="run-parse" />)

    expect(screen.getByText('演示文稿解析失败')).toBeTruthy()
    expect(screen.getByText(/第 2 行/)).toBeTruthy()
    expect(screen.getByText(/position \d+/)).toBeTruthy()
    expect(screen.getByText('"slides": [{"layout":"title","title":"Bad",}]')).toBeTruthy()

    await waitFor(() => expect(new RunLedger('run-parse').find('artifact.parse_failed')).toHaveLength(1))
    view.rerender(<PresentationArtifactRenderer content={invalid} artifactId="deck-1" runId="run-parse" />)
    await waitFor(() => expect(new RunLedger('run-parse').find('artifact.parse_failed')).toHaveLength(1))
    expect(new RunLedger('run-parse').find('artifact.parse_failed')[0].payload).toMatchObject({
      artifactId: 'deck-1',
      stage: 'bundle-json',
      line: 2,
    })
  })
})
