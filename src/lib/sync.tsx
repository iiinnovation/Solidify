/**
 * 离线检测与同步管理
 */

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from '@/stores/toast-store'

/**
 * Hook: 检测在线/离线状态
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      toast.success('网络已恢复')
    }

    const handleOffline = () => {
      setIsOnline(false)
      toast.info('网络已断开，将使用本地缓存')
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}

/**
 * Hook: 自动同步管理
 * 在线时自动刷新数据
 */
export function useAutoSync() {
  const queryClient = useQueryClient()
  const isOnline = useOnlineStatus()

  useEffect(() => {
    if (isOnline) {
      // 网络恢复时，刷新所有查询
      queryClient.invalidateQueries()
    }
  }, [isOnline, queryClient])

  return { isOnline }
}

/**
 * 同步状态指示器组件
 */
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
