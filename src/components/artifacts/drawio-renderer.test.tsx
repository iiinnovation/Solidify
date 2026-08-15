import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DrawioRenderer } from './drawio-renderer'

function xml(label: string): string {
  return `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" vertex="1" parent="1"><mxGeometry x="10" y="10" width="120" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`
}

describe('DrawioRenderer streaming updates', () => {
  it('does not trigger React update-depth errors during rapid content changes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const view = render(<DrawioRenderer content={xml('0')} streaming />)
      for (let index = 1; index <= 80; index++) {
        view.rerender(<DrawioRenderer content={xml(String(index))} streaming />)
      }
      view.rerender(<DrawioRenderer content={xml('final')} streaming={false} />)

      await waitFor(() => {
        expect(view.container.textContent).not.toContain('生成中')
      })
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('Maximum update depth exceeded')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('renders orthogonal edges and keeps swimlane titles away from the center path', () => {
    const content = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="layer" value="应用层" style="swimlane;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="500" height="220" as="geometry"/></mxCell>
      <mxCell id="a" value="服务A" vertex="1" parent="layer"><mxGeometry x="40" y="50" width="100" height="50" as="geometry"/></mxCell>
      <mxCell id="b" value="服务B" vertex="1" parent="layer"><mxGeometry x="300" y="110" width="100" height="50" as="geometry"/></mxCell>
      <mxCell id="edge" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="layer" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`

    const view = render(<DrawioRenderer content={content} streaming={false} />)
    const edge = view.container.querySelector('svg > path[marker-end]')
    const layerLabel = [...view.container.querySelectorAll('text')]
      .find((item) => item.textContent === '应用层')

    expect(edge?.getAttribute('d')).toBe('M140,75 L220,75 L220,135 L300,135')
    expect(layerLabel?.getAttribute('text-anchor')).toBe('start')
    expect(Number(layerLabel?.getAttribute('x'))).toBeLessThan(40)
  })
})
