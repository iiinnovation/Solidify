import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ProjectPicker } from './project-picker'
import { useWorkspaceStore } from '@/stores/workspace-store'

function renderCompactPicker() {
  return render(
    <MemoryRouter>
      <ProjectPicker compact />
    </MemoryRouter>,
  )
}

describe('ProjectPicker compact mode', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      workspaceRoot: null,
      project: null,
      status: 'idle',
      error: null,
      open: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(undefined),
    })
  })

  it('shows sidebar-sized actions when no workspace is open', () => {
    renderCompactPicker()

    expect(screen.getByText('未打开工作区')).not.toBeNull()
    expect(screen.getByRole('button', { name: '打开' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '新建' })).not.toBeNull()
  })

  it('can cancel project creation and clears the entered name', () => {
    renderCompactPicker()

    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    const input = screen.getByRole('textbox', { name: '项目名称' })
    fireEvent.change(input, { target: { value: '测试项目' } })

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(screen.queryByRole('textbox', { name: '项目名称' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '新建' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '项目名称' }).value).toBe('')
  })
})
