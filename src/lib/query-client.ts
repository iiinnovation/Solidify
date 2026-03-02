import { QueryClient } from '@tanstack/react-query'

/**
 * TanStack Query 配置
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 分钟
      gcTime: 30 * 60 * 1000, // 30 分钟（原 cacheTime）
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
    mutations: {
      retry: 1,
    },
  },
})
