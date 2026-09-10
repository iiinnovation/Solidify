import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), install: vi.fn(), check: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); vi.resetModules(); vi.clearAllMocks() })

it('requests backend cleanup before the installed update restarts', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  const order: string[] = []
  mocks.check.mockResolvedValue({ downloadAndInstall: mocks.install })
  mocks.install.mockImplementation(async () => { order.push('installed') })
  mocks.invoke.mockImplementation(async (command) => { order.push(command) })
  const { downloadAndInstallUpdate } = await import('./tauri')
  expect(await downloadAndInstallUpdate()).toBe(true)
  expect(order).toEqual(['installed', 'restart_after_cleanup'])
  expect(mocks.invoke).toHaveBeenCalledWith('restart_after_cleanup', {})
})
