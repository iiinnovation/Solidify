import { useQuery } from '@tanstack/react-query'
import { searchContent } from '@/lib/api/search'

/**
 * 全文搜索 Hook
 */
export function useSearch(query: string) {
  return useQuery({
    queryKey: ['search', query],
    queryFn: () => searchContent(query),
    enabled: query.trim().length >= 2, // 至少 2 个字符才搜索
    staleTime: 30 * 1000, // 30 秒
  })
}
