import { supabase } from '@/lib/supabase'

export interface SearchResult {
  result_type: 'message' | 'artifact' | 'conversation'
  result_id: string
  conversation_id: string
  title: string
  content: string
  rank: number
}

/**
 * 全文搜索
 */
export async function searchContent(query: string): Promise<SearchResult[]> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data, error } = await supabase.rpc('search_content', {
    search_query: query,
  })

  if (error) throw error
  return data || []
}
