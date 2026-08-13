/**
 * 离线检测与自动同步 hooks
 *
 * 与 SyncIndicator 组件分开放置：组件文件混入非组件导出会破坏 Fast Refresh。
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
