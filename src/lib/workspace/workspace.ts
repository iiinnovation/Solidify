import {
  closeWorkspace as closeWorkspaceCommand,
  createWorkspace as createWorkspaceCommand,
  restoreWorkspace,
  selectWorkspace,
  type LocalWorkspaceInfo,
} from '@/lib/tauri'
import type { WorkspaceInfo } from './types'

function toWorkspaceInfo(info: LocalWorkspaceInfo): WorkspaceInfo {
  return { root: info.root, project: info.project }
}

export async function openLocalWorkspace(): Promise<WorkspaceInfo | null> {
  const root = await selectWorkspace()
  if (!root) return null
  return toWorkspaceInfo(await restoreWorkspace(root))
}

export async function restoreLocalWorkspace(root: string): Promise<WorkspaceInfo> {
  return toWorkspaceInfo(await restoreWorkspace(root))
}

export async function createLocalWorkspace(name: string): Promise<WorkspaceInfo | null> {
  const info = await createWorkspaceCommand(name)
  return info ? toWorkspaceInfo(info) : null
}

export async function closeLocalWorkspace(): Promise<void> {
  await closeWorkspaceCommand()
}
