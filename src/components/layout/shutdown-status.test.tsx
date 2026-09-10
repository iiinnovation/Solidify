import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ status: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ isTauri: true, appShutdownStatus: bridge.status }))
import { ShutdownStatus } from './shutdown-status'

beforeEach(() => { vi.useFakeTimers(); bridge.status.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('keeps delayed shutdown visible across a lost status query and offers retry after cleanup failure', async () => {
  bridge.status.mockResolvedValueOnce('idle').mockResolvedValueOnce('stopping')
    .mockResolvedValueOnce('delayed').mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce('failed').mockResolvedValue('ready')
  render(<ShutdownStatus />)
  await act(async () => {})
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.getByText('正在停止后台作业并清理临时文件，完成后退出或重启…')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(screen.getByText('仍在等待后台作业和临时文件回收，完成后自动退出或重启。')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.getByText('后台作业清理或任务进度保存失败，应用尚未退出。再次关闭可重试。')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(screen.getByText('清理完成，正在退出或重启…')).toBeTruthy()
})

it('stops querying after the layout unmounts', async () => {
  bridge.status.mockResolvedValue('stopping')
  const view = render(<ShutdownStatus />)
  await act(async () => {})
  view.unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(bridge.status).toHaveBeenCalledTimes(1)
})
