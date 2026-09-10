import { useEffect, useState } from 'react'
import { folderTaskClient } from '@/lib/folder-tasks/client'
import type { SandboxDocumentProgress } from '@/lib/folder-tasks/sandbox'

/** Poll backend-owned current state so remount/reconnect does not need old events. */
export function FolderTaskOcrProgress({ taskId, enabled }: { taskId: string; enabled: boolean }) {
  const [snapshot, setSnapshot] = useState<{ taskId: string; entries: SandboxDocumentProgress[]; unavailable: boolean } | null>(null)
  useEffect(() => {
    setSnapshot(null)
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const entries = await folderTaskClient.executionProgress(taskId)
        if (!disposed) setSnapshot({ taskId, entries: entries.filter((entry) => entry.taskId === taskId), unavailable: false })
      } catch {
        // A lost query is not proof that the converter stopped or completed.
        if (!disposed) setSnapshot({ taskId, entries: [], unavailable: true })
      }
      if (!disposed) timer = setTimeout(refresh, 1_000)
    }
    void refresh()
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
  }, [taskId, enabled])

  if (!enabled || snapshot?.taskId !== taskId) return null
  if (snapshot.unavailable) return <span role="status" className="block text-xs text-text-secondary">转换进度暂不可用，请以任务状态为准。</span>
  if (snapshot.entries.length === 0) return null
  return <span role="status" className="block space-y-1 text-xs text-text-secondary">
    {snapshot.entries.map((entry) => <span key={entry.executionId} className="block break-words">
      {entry.relativePath}：{entry.phase === 'stopping' ? '正在停止转换并回收进程…'
        : entry.phase === 'preparing' ? '正在准备 OCR 输入…'
          : entry.phase === 'finished' || (entry.totalPages !== null && entry.completedPages === entry.totalPages)
            ? `已处理 ${entry.completedPages} 页，正在完成校验与清理…`
            : entry.totalPages === null ? '正在检查文档页数…'
              : `OCR 已处理 ${entry.completedPages}/${entry.totalPages} 页…`}
    </span>)}
  </span>
}
