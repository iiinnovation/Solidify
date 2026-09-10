import type { FolderTaskDetail } from './types'

export function folderTaskRemainingRunnableItems(task: FolderTaskDetail): number {
  return task.progress.pending + task.progress.processing
}

export function shouldAutoContinueFolderTask(task: FolderTaskDetail): boolean {
  return ['awaiting_plan_confirmation', 'running'].includes(task.status)
    && folderTaskRemainingRunnableItems(task) > 0
}
