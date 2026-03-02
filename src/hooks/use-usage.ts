import { useQuery } from '@tanstack/react-query'
import { getUsageStats, type UsageQuery } from '@/lib/api/usage'

/**
 * 获取用量统计
 */
export function useUsageStats(query: UsageQuery = {}) {
  return useQuery({
    queryKey: ['usage-stats', query],
    queryFn: () => getUsageStats(query),
    staleTime: 60 * 1000, // 1 分钟
  })
}
