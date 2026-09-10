import { beforeEach, describe, expect, it, vi } from 'vitest'
const bridge = vi.hoisted(() => ({ sandboxExtractText: vi.fn(), sandboxCancelExecution: vi.fn() }))
vi.mock('@/lib/tauri', () => bridge)
import { folderTaskClient } from './client'
import type { SandboxExtractionRequest } from './sandbox'

const input: SandboxExtractionRequest = {
  taskId: 'task', runId: 'run', batchToken: 'token', callId: 'call', relativePath: 'photo.png', method: 'image_ocr',
}

describe('sandbox desktop cancellation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('does not start an already aborted extraction', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(folderTaskClient.extractText(input, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.sandboxExtractText).not.toHaveBeenCalled()
  })

  it('waits for Rust completion after cancellation and discards the late result', async () => {
    let finish!: (result: unknown) => void
    bridge.sandboxExtractText.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    bridge.sandboxCancelExecution.mockResolvedValue(undefined)
    const controller = new AbortController()
    let settled = false
    const result = folderTaskClient.extractText(input, controller.signal).then(
      (value) => { settled = true; return value },
      (error: unknown) => { settled = true; return error },
    )
    controller.abort()
    await Promise.resolve()
    expect(bridge.sandboxCancelExecution).toHaveBeenCalledExactlyOnceWith(input)
    expect(settled).toBe(false)
    finish({ complete: true, pages: [{ page: 1, text: 'late' }] })
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(settled).toBe(true)
  })

  it('reports unconfirmed cancellation rather than accepting late text', async () => {
    let finish!: (result: unknown) => void
    bridge.sandboxExtractText.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    bridge.sandboxCancelExecution.mockRejectedValue(new Error('transport failed'))
    const controller = new AbortController()
    const result = folderTaskClient.extractText(input, controller.signal)
    controller.abort()
    finish({ complete: true })
    await expect(result).rejects.toThrow('取消请求未获确认')
  })

  it('removes the abort listener after successful completion', async () => {
    bridge.sandboxExtractText.mockResolvedValue({ complete: true })
    const controller = new AbortController()
    await expect(folderTaskClient.extractText(input, controller.signal)).resolves.toEqual({ complete: true })
    controller.abort()
    expect(bridge.sandboxCancelExecution).not.toHaveBeenCalled()
  })
})
