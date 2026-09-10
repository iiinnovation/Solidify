import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const capabilities = vi.hoisted(() => vi.fn())
vi.mock('@/lib/folder-tasks/client', () => ({ folderTaskClient: { sandboxCapabilities: capabilities } }))
import { FolderTaskOcrStatus } from './folder-task-ocr-status'

describe('FolderTask OCR capability notice', () => {
  beforeEach(() => { capabilities.mockReset() })
  it('shows the backend reason and refreshes without requeueing files', async () => {
    capabilities.mockResolvedValue([{ method: 'image_ocr', available: false, reason: '缺少中文语言包' }])
    render(<FolderTaskOcrStatus taskId="task" />)
    expect(await screen.findByText(/图片 OCR：不可用 — 缺少中文语言包/)).toBeTruthy()
    capabilities.mockResolvedValue([{ method: 'image_ocr', available: true }])
    fireEvent.focus(window)
    expect(await screen.findByText(/图片 OCR：组件就绪/)).toBeTruthy()
    expect(screen.getByText(/组件就绪不会自动重试/)).toBeTruthy()
  })
  it('ignores stale responses after task changes and fails closed', async () => {
    let resolveOld!: (value: unknown) => void
    capabilities.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    const view = render(<FolderTaskOcrStatus taskId="old" />)
    capabilities.mockRejectedValue(new Error('IPC unavailable'))
    view.rerender(<FolderTaskOcrStatus taskId="new" />)
    expect(await screen.findByText(/图片 OCR：不可用 — 无法确认/)).toBeTruthy()
    await act(async () => { resolveOld([{ method: 'image_ocr', available: true }]) })
    expect(screen.queryByText(/图片 OCR：组件就绪/)).toBeNull()
  })
})
