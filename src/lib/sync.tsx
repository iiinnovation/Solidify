/**
 * 同步状态指示器
 */

import { useQueryClient } from '@tanstack/react-query'
import { useAutoSync } from '@/hooks/use-sync'

export function SyncIndicator() {
  const { isOnline } = useAutoSync()
  const queryClient = useQueryClient()
  const isSyncing = queryClient.isFetching() > 0

  if (!isOnline) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-warning-light text-warning text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-warning" />
        离线模式
      </div>
    )
  }

  if (isSyncing) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-info-light text-info text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
        同步中
      </div>
    )
  }

  return null
}
