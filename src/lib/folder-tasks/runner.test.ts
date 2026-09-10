import { describe, expect, it } from 'vitest'
import { folderTaskRemainingRunnableItems, shouldAutoContinueFolderTask } from './runner'
import type { FolderTaskDetail } from './types'

function task(status: FolderTaskDetail['status'], pending: number, processing = 0): FolderTaskDetail {
  return { status, progress: { pending, processing } } as FolderTaskDetail
}

describe('FolderTask automatic runner policy', () => {
  it('continues only while durable runnable work remains', () => {
    expect(shouldAutoContinueFolderTask(task('running', 2))).toBe(true)
    expect(shouldAutoContinueFolderTask(task('running', 0, 1))).toBe(true)
    expect(shouldAutoContinueFolderTask(task('running', 0))).toBe(false)
    expect(shouldAutoContinueFolderTask(task('awaiting_plan_confirmation', 2))).toBe(true)
    expect(shouldAutoContinueFolderTask(task('awaiting_decision', 2))).toBe(false)
    expect(shouldAutoContinueFolderTask(task('failed', 2))).toBe(false)
  })

  it('counts only pending and currently leased work', () => {
    expect(folderTaskRemainingRunnableItems(task('running', 3, 2))).toBe(5)
  })
})
