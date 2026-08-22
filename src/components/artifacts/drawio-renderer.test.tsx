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

  it('preserves authored colours and treats literal backslash-n labels as line breaks', () => {
    const content = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="node" value="智能校对\\n语义提炼" style="rounded=1;fillColor=#DCFCE7;strokeColor=#16A34A;fontColor=#14532D;" vertex="1" parent="1">
        <mxGeometry x="20" y="20" width="180" height="68" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`

    const view = render(<DrawioRenderer content={content} streaming={false} />)
    const node = view.container.querySelector('svg > rect')
    const labels = [...view.container.querySelectorAll('text')].map((item) => item.textContent)

    expect(node?.getAttribute('fill')).toBe('#DCFCE7')
    expect(node?.getAttribute('stroke')).toBe('#16A34A')
    expect(labels).toEqual(['智能校对', '语义提炼'])
  })

  it('recovers child vertices authored with canvas coordinates inside a swimlane', () => {
    const content = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="layer" value="模型服务层" style="swimlane;" vertex="1" parent="1">
        <mxGeometry x="40" y="280" width="1120" height="160" as="geometry"/>
      </mxCell>
      <mxCell id="service" value="大模型服务" style="rounded=1;fillColor=#EDE9FE;strokeColor=#7C3AED;" vertex="1" parent="layer">
        <mxGeometry x="150" y="340" width="180" height="60" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`

    const view = render(<DrawioRenderer content={content} streaming={false} />)
    const service = [...view.container.querySelectorAll('svg > rect')]
      .find((item) => item.getAttribute('fill') === '#EDE9FE')

    expect(service?.getAttribute('x')).toBe('150')
    expect(service?.getAttribute('y')).toBe('340')
  })

  it('renders namespaced XML and labels containing a bare ampersand', () => {
    const content = `<?xml version="1.0"?><mxfile xmlns="urn:drawio"><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="node" value="输入 & 校验" vertex="1" parent="1"><mxGeometry x="20" y="20" width="180" height="68" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`

    const view = render(<DrawioRenderer content={content} streaming={false} />)
    expect(view.container.querySelector('svg')).toBeTruthy()
    expect(view.container.textContent).not.toContain('本地预览不可用')
    expect([...view.container.querySelectorAll('text')].map((item) => item.textContent)).toContain('输入 & 校验')
  })

  it('renders labels stored in the newer mxLabel child format', () => {
    const content = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="node" style="rounded=1;fillColor=#DBEAFE;strokeColor=#1E40AF;" vertex="1" parent="1">
        <mxGeometry x="20" y="20" width="240" height="80" as="geometry"/>
        <mxLabel label="政务·数字审计 AI 综合场景建设技术架构" label1="基础设施与数据支撑层" label2="模型服务层"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`

    const view = render(<DrawioRenderer content={content} streaming={false} />)
    expect([...view.container.querySelectorAll('text')].map((item) => item.textContent))
      .toContain('政务·数字审计 AI 综合场景建设技术架构')
  })

  it('does not expose partial Draw.io XML as a code block while streaming', () => {
    const view = render(<DrawioRenderer content="<mxfile><diagram>" streaming />)
    expect(view.container.querySelector('pre')).toBeNull()
    expect(view.container.textContent).toContain('正在解析 Draw.io 图形结构')
  })
})
