import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const { startDragging } = vi.hoisted(() => ({ startDragging: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/tauri', () => ({ isTauri: true }))
vi.mock('@/components/shared/theme-toggle', () => ({ ThemeToggle: () => null }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ startDragging }) }))

import { Header } from './header'

describe('desktop window header', () => {
  beforeEach(() => startDragging.mockClear())

  it('starts native dragging from the visible header surface', () => {
    const { container } = render(<MemoryRouter><Header /></MemoryRouter>)
    const header = container.querySelector('header')

    expect(header).not.toBeNull()
    fireEvent.mouseDown(header!, { button: 0 })
    expect(startDragging).toHaveBeenCalledOnce()
  })

  it('does not start dragging from buttons', () => {
    render(<MemoryRouter><Header /></MemoryRouter>)

    fireEvent.mouseDown(screen.getByRole('button', { name: '切换侧边栏' }), { button: 0 })
    expect(startDragging).not.toHaveBeenCalled()
  })
})
