import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SandboxDocumentProgress } from '@/lib/folder-tasks/sandbox'
const client = vi.hoisted(() => ({ executionProgress: vi.fn() }))
vi.mock('@/lib/folder-tasks/client', () => ({ folderTaskClient: client }))
import { FolderTaskOcrProgress } from './folder-task-ocr-progress'

const progress: SandboxDocumentProgress = {
  executionId: 'execution', taskId: 'task', runId: 'run', relativePath: '合同.pdf',
  method: 'pdf_ocr', phase: 'running', completedPages: 1, totalPages: 2,
}
beforeEach(() => { vi.useFakeTimers(); client.executionProgress.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('synchronizes page progress, keeps stopping visible, and clears after backend retirement', async () => {
  client.executionProgress.mockResolvedValueOnce([progress])
    .mockResolvedValueOnce([{ ...progress, phase: 'stopping' }]).mockResolvedValue([])
  render(<FolderTaskOcrProgress taskId="task" enabled />)
  await act(async () => {})
  expect(screen.getByText('合同.pdf：OCR 已处理 1/2 页…')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByText('合同.pdf：正在停止转换并回收进程…')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.queryByRole('status')).toBeNull()
})

it('does not equate all processed pages or a query failure with successful task completion', async () => {
  client.executionProgress.mockResolvedValueOnce([{ ...progress, completedPages: 2 }])
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  render(<FolderTaskOcrProgress taskId="task" enabled />)
  await act(async () => {})
  expect(screen.getByText('合同.pdf：已处理 2 页，正在完成校验与清理…')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByText('转换进度暂不可用，请以任务状态为准。')).toBeTruthy()
  expect(screen.queryByText(/已处理 2 页/)).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.queryByRole('status')).toBeNull()
})

it('ignores a late response after switching tasks and stops polling when disabled', async () => {
  let resolveFirst!: (value: SandboxDocumentProgress[]) => void
  client.executionProgress.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    .mockResolvedValue([{ ...progress, taskId: 'next', relativePath: '新文件.pdf' }, progress])
  const { rerender } = render(<FolderTaskOcrProgress taskId="task" enabled />)
  rerender(<FolderTaskOcrProgress taskId="next" enabled />)
  await act(async () => {})
  await act(async () => { resolveFirst([progress]) })
  expect(screen.getByText('新文件.pdf：OCR 已处理 1/2 页…')).toBeTruthy()
  expect(screen.queryByText(/合同.pdf/)).toBeNull()
  rerender(<FolderTaskOcrProgress taskId="next" enabled={false} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(client.executionProgress).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('status')).toBeNull()
})

it('loads the current backend snapshot after remount without replaying old events', async () => {
  client.executionProgress.mockResolvedValue([{ ...progress, phase: 'preparing', totalPages: null, completedPages: 0 }])
  const first = render(<FolderTaskOcrProgress taskId="task" enabled />)
  await act(async () => {})
  expect(screen.getByText('合同.pdf：正在准备 OCR 输入…')).toBeTruthy()
  first.unmount()
  client.executionProgress.mockResolvedValue([progress])
  render(<FolderTaskOcrProgress taskId="task" enabled />)
  await act(async () => {})
  expect(screen.getByText('合同.pdf：OCR 已处理 1/2 页…')).toBeTruthy()
})
