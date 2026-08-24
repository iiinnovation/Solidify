import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ResizablePanel } from './resizable-panel'
import { Workbench } from './workbench'

describe('on-demand preview layouts', () => {
  it('does not mount the legacy preview until it is opened', () => {
    const { rerender } = render(
      <ResizablePanel left={<div>Chat</div>} right={<div>Preview</div>} rightOpen={false} leftWidth={440} onResize={() => undefined} />,
    )

    expect(screen.queryByText('Preview')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()

    rerender(<ResizablePanel left={<div>Chat</div>} right={<div>Preview</div>} rightOpen leftWidth={440} onResize={() => undefined} />)
    expect(screen.getByText('Preview')).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
  })

  it('does not mount the workbench viewer until it is opened', () => {
    const { rerender } = render(<Workbench chat={<div>Chat</div>} viewer={<div>Document</div>} viewerOpen={false} />)

    expect(screen.queryByText('Document')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()

    rerender(<Workbench chat={<div>Chat</div>} viewer={<div>Document</div>} viewerOpen />)
    expect(screen.getByText('Document')).toBeTruthy()
    expect(screen.getByRole('separator')).toBeTruthy()
  })
})
