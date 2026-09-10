import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrInstallationSnapshot } from '@/lib/ocr-installation'
const bridge = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), cancel: vi.fn(), retry: vi.fn(), open: vi.fn() }))
vi.mock('@/lib/tauri', () => ({ ocrInstallationStatus: bridge.status, ocrPreparePackage: bridge.start, ocrCancelPreparation: bridge.cancel, ocrRetryPreparationCleanup: bridge.retry, openFileDialog: bridge.open }))
import { OcrPackagePreparation } from './ocr-package-preparation'

const idle = (): OcrInstallationSnapshot => ({ canPrepare: true, unavailableReason: null, closing: false, job: null })
let state: OcrInstallationSnapshot
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); state = idle()
  bridge.status.mockImplementation(async () => state)
  bridge.start.mockResolvedValue('job'); bridge.cancel.mockResolvedValue(undefined); bridge.retry.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })
const settle = async () => { await act(async () => {}) }

describe('OCR package preparation', () => {
  it('disables file selection and preparation when release trust is unavailable', async () => {
    state = { ...idle(), canPrepare: false, unavailableReason: '尚未配置可信 OCR 发布公钥' }
    render(<OcrPackagePreparation />); await settle()
    expect(screen.getByText('尚未配置可信 OCR 发布公钥')).toBeTruthy()
    expect(screen.getByRole('button', { name: '校验组件包' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '选择发布描述' })).toHaveProperty('disabled', true)
    expect(bridge.open).not.toHaveBeenCalled()
  })

  it('passes the selected paths and waits for backend cancellation rather than announcing completion', async () => {
    render(<OcrPackagePreparation />); await settle()
    for (const [label, path] of [['发布描述', '/tmp/release.json'], ['发布签名', '/tmp/release.json.minisig'], ['组件归档', '/tmp/package.zip']]) {
      bridge.open.mockResolvedValueOnce(path)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: `选择${label}` })) })
    }
    bridge.start.mockImplementation(async () => {
      state = { ...idle(), job: { id: 'job', status: 'running', error: null, progress: { phase: 'copying_archive', completedBytes: 50, totalBytes: 100, completedFiles: 0, totalFiles: null } } }
      return 'job'
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '校验组件包' })) })
    expect(bridge.start).toHaveBeenCalledWith({ descriptorPath: '/tmp/release.json', signaturePath: '/tmp/release.json.minisig', archivePath: '/tmp/package.zip' })
    expect(screen.getByText('正在复制归档')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50')
    bridge.cancel.mockImplementation(async () => { state = { ...state, job: { ...state.job!, status: 'stopping' } } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消校验' })) })
    expect(bridge.cancel).toHaveBeenCalledWith('job')
    expect(screen.getByText('正在取消并回收')).toBeTruthy()
    expect(screen.queryByText('校验已取消')).toBeNull()
    expect(screen.getByRole('button', { name: '取消校验' })).toHaveProperty('disabled', true)
    state = { ...state, job: { ...state.job!, status: 'cancelled', progress: null } }
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('校验已取消')).toBeTruthy()
  })

  it('shows validated as uninstalled and does not activate capabilities or retry document tasks', async () => {
    state.job = { id: 'job', status: 'validated', progress: null, error: null }
    render(<OcrPackagePreparation />); await settle()
    expect(screen.getByText('组件包校验通过，未安装')).toBeTruthy()
    expect(bridge.start).not.toHaveBeenCalled()
    expect(screen.queryByText('组件就绪')).toBeNull()
  })

  it('retries retained cleanup explicitly and blocks a new preparation', async () => {
    state.job = { id: 'failed-job', status: 'cleanup_failed', progress: null, error: { code: 'stop_failed', message: '清理失败' } }
    render(<OcrPackagePreparation />); await settle()
    expect(screen.getByRole('button', { name: '校验组件包' })).toHaveProperty('disabled', true)
    bridge.retry.mockImplementation(async () => { state.job = { ...state.job!, status: 'cleaned', error: null } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试清理' })) })
    expect(bridge.retry).toHaveBeenCalledWith('failed-job')
    expect(screen.getByText('暂存已清理')).toBeTruthy()
  })

  it('fails closed on a status query failure and stops polling after unmount', async () => {
    state.job = { id: 'job', status: 'running', progress: null, error: null }
    const view = render(<OcrPackagePreparation />); await settle()
    bridge.status.mockRejectedValue(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('无法查询组件作业状态')).toBeTruthy()
    expect(screen.getByRole('button', { name: '校验组件包' })).toHaveProperty('disabled', true)
    view.unmount()
    const calls = bridge.status.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(bridge.status).toHaveBeenCalledTimes(calls)
  })

  it('recovers the backend job on remount and ignores a late response from the old view', async () => {
    let resolveOld!: (value: OcrInstallationSnapshot) => void
    bridge.status.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const view = render(<OcrPackagePreparation />)
    view.unmount()
    state.job = { id: 'current-job', status: 'stopping', progress: null, error: null }
    render(<OcrPackagePreparation />); await settle()
    await act(async () => { resolveOld({ ...idle(), job: { id: 'old', status: 'validated', progress: null, error: null } }) })
    expect(screen.getByText('正在取消并回收')).toBeTruthy()
    expect(screen.queryByText('组件包校验通过，未安装')).toBeNull()
  })
})
