import { afterEach, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.resetModules(); vi.clearAllMocks() })
it('uses fixed IPC commands with selection or backend job identity only', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  const api = await import('./tauri')
  const selection = { archivePath: '/archive', descriptorPath: '/descriptor', signaturePath: '/signature' }
  await api.ocrInstallationStatus(); await api.ocrPreparePackage(selection)
  await api.ocrCancelPreparation('job'); await api.ocrRetryPreparationCleanup('job')
  expect(invoke.mock.calls).toEqual([
    ['ocr_installation_status', {}], ['ocr_prepare_package', { selection }],
    ['ocr_cancel_preparation', { jobId: 'job' }], ['ocr_retry_preparation_cleanup', { jobId: 'job' }],
  ])
})
