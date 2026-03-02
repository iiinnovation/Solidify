/**
 * Tauri 桌面端能力封装层
 *
 * 所有 Tauri API 调用都通过此模块间接调用，
 * Web 端运行时自动降级为 no-op / 浏览器 fallback。
 *
 * 业务组件不应直接 import @tauri-apps/api。
 */

/** 是否运行在 Tauri 桌面端 */
export const isTauri = '__TAURI_INTERNALS__' in window

/** 当前操作系统平台 */
export type Platform = 'macos' | 'windows' | 'linux' | 'web'

let _platform: Platform | null = null

export async function getPlatform(): Promise<Platform> {
  if (_platform) return _platform
  if (!isTauri) {
    _platform = 'web'
    return _platform
  }
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    const p = platform()
    if (p === 'macos') _platform = 'macos'
    else if (p === 'windows') _platform = 'windows'
    else if (p === 'linux') _platform = 'linux'
    else _platform = 'web'
  } catch {
    _platform = 'web'
  }
  return _platform
}

// ─── 文件对话框 ──────────────────────────────────────────

export interface SaveFileOptions {
  defaultName?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface OpenFileOptions {
  filters?: { name: string; extensions: string[] }[]
  multiple?: boolean
}

/** 打开文件选择对话框，返回文件路径（Web 端降级为 file input） */
export async function openFileDialog(
  options?: OpenFileOptions,
): Promise<string | string[] | null> {
  if (!isTauri) return null
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const result = await open({
      multiple: options?.multiple ?? false,
      filters: options?.filters,
    })
    return result
  } catch {
    return null
  }
}

/** 打开保存文件对话框，返回保存路径 */
export async function saveFileDialog(
  options?: SaveFileOptions,
): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const result = await save({
      defaultPath: options?.defaultName,
      filters: options?.filters,
    })
    return result
  } catch {
    return null
  }
}

// ─── 文件系统 ──────────────────────────────────────────

/** 读取本地文件（文本） */
export async function readTextFile(path: string): Promise<string | null> {
  if (!isTauri) return null
  try {
    const { readTextFile: read } = await import('@tauri-apps/plugin-fs')
    return await read(path)
  } catch {
    return null
  }
}

/** 读取本地文件（二进制） */
export async function readBinaryFile(path: string): Promise<Uint8Array | null> {
  if (!isTauri) return null
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs')
    return await readFile(path)
  } catch {
    return null
  }
}

/** 写入本地文件（文本） */
export async function writeTextFile(
  path: string,
  content: string,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { writeTextFile: write } = await import('@tauri-apps/plugin-fs')
    await write(path, content)
    return true
  } catch {
    return false
  }
}

/** 写入本地文件（二进制） */
export async function writeBinaryFile(
  path: string,
  data: Uint8Array,
): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    await writeFile(path, data)
    return true
  } catch {
    return false
  }
}

/** 统一保存文件入口：Tauri 用原生对话框 + writeBinaryFile，Web 用 file-saver */
export async function saveFile(
  blob: Blob,
  defaultName: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<boolean> {
  if (isTauri) {
    const path = await saveFileDialog({ defaultName, filters })
    if (!path) return false
    const buffer = await blob.arrayBuffer()
    return writeBinaryFile(path, new Uint8Array(buffer))
  }
  // Web 端降级为 file-saver
  const { saveAs } = await import('file-saver')
  saveAs(blob, defaultName)
  return true
}

// ─── 系统通知 ──────────────────────────────────────────

/** 发送系统通知 */
export async function sendNotification(
  title: string,
  body?: string,
): Promise<void> {
  if (!isTauri) {
    // Web 端降级为浏览器通知
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body })
    }
    return
  }
  try {
    const { sendNotification: notify } = await import(
      '@tauri-apps/plugin-notification'
    )
    notify({ title, body })
  } catch {
    // 静默失败
  }
}

/** 请求通知权限 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isTauri) {
    if ('Notification' in window) {
      const result = await Notification.requestPermission()
      return result === 'granted'
    }
    return false
  }
  try {
    const {
      isPermissionGranted,
      requestPermission,
    } = await import('@tauri-apps/plugin-notification')
    let granted = await isPermissionGranted()
    if (!granted) {
      const permission = await requestPermission()
      granted = permission === 'granted'
    }
    return granted
  } catch {
    return false
  }
}

// ─── 自动更新 ──────────────────────────────────────────

export interface UpdateResult {
  available: boolean
  version?: string
  notes?: string
}

/** 检查更新（静默，不阻塞 UI） */
export async function checkForUpdates(): Promise<UpdateResult> {
  if (!isTauri) return { available: false }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      return {
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
      }
    }
    return { available: false }
  } catch {
    return { available: false }
  }
}

/** 下载并安装更新 */
export async function downloadAndInstallUpdate(): Promise<boolean> {
  if (!isTauri) return false
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      await update.downloadAndInstall()
      // 安装后需要重启应用
      const { relaunch } = await import('@tauri-apps/plugin-process')
      await relaunch()
      return true
    }
    return false
  } catch {
    return false
  }
}
