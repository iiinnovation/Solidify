import { useEffect, useState } from 'react'
import { appShutdownStatus, isTauri, type AppShutdownStatus } from '@/lib/tauri'

export function ShutdownStatus() {
  const [status, setStatus] = useState<AppShutdownStatus>('idle')
  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const status = await appShutdownStatus()
        if (!disposed) setStatus(status)
      } catch { /* A failed query cannot confirm that shutdown finished. */ }
      if (!disposed) timer = setTimeout(refresh, 500)
    }
    void refresh()
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
  }, [])
  if (status === 'idle') return null
  return <div role="status" className="border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-text-primary">
    {status === 'failed' ? '后台作业清理或任务进度保存失败，应用尚未退出。再次关闭可重试。'
      : status === 'delayed' ? '仍在等待后台作业和临时文件回收，完成后自动退出或重启。'
        : status === 'ready' ? '清理完成，正在退出或重启…'
          : '正在停止后台作业并清理临时文件，完成后退出或重启…'}
  </div>
}
