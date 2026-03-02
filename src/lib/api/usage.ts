import { supabase } from '@/lib/supabase'

export interface UsageStats {
  total_tokens: number
  total_cost: number
  by_model: {
    model: string
    tokens: number
    cost: number
    count: number
  }[]
  by_date: {
    date: string
    tokens: number
    cost: number
  }[]
}

export interface UsageQuery {
  user_id?: string
  start_date?: string
  end_date?: string
  project_id?: string
}

/**
 * 获取用量统计
 */
export async function getUsageStats(query: UsageQuery = {}): Promise<UsageStats> {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  // 构建查询
  let queryBuilder = supabase
    .from('usage_logs')
    .select('*')
    .eq('user_id', query.user_id ?? user.id)

  if (query.start_date) {
    queryBuilder = queryBuilder.gte('created_at', query.start_date)
  }
  if (query.end_date) {
    queryBuilder = queryBuilder.lte('created_at', query.end_date)
  }

  const { data, error } = await queryBuilder

  if (error) throw error

  // 计算统计数据
  const total_tokens = data.reduce((sum, log) => sum + log.total_tokens, 0)
  const total_cost = data.reduce((sum, log) => sum + (log.cost_usd || 0), 0)

  // 按模型统计
  const modelMap = new Map<string, { tokens: number; cost: number; count: number }>()
  data.forEach((log) => {
    const existing = modelMap.get(log.model) || { tokens: 0, cost: 0, count: 0 }
    modelMap.set(log.model, {
      tokens: existing.tokens + log.total_tokens,
      cost: existing.cost + (log.cost_usd || 0),
      count: existing.count + 1,
    })
  })

  const by_model = Array.from(modelMap.entries()).map(([model, stats]) => ({
    model,
    ...stats,
  }))

  // 按日期统计
  const dateMap = new Map<string, { tokens: number; cost: number }>()
  data.forEach((log) => {
    const date = new Date(log.created_at).toISOString().split('T')[0]
    const existing = dateMap.get(date) || { tokens: 0, cost: 0 }
    dateMap.set(date, {
      tokens: existing.tokens + log.total_tokens,
      cost: existing.cost + (log.cost_usd || 0),
    })
  })

  const by_date = Array.from(dateMap.entries())
    .map(([date, stats]) => ({ date, ...stats }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    total_tokens,
    total_cost,
    by_model,
    by_date,
  }
}

/**
 * 记录用量（由 Edge Function 调用）
 */
export async function logUsage(data: {
  conversation_id?: string
  model: string
  input_tokens: number
  output_tokens: number
  cost_usd?: number
}) {
  if (!supabase) throw new Error('Supabase 未配置')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('未登录')

  const { error } = await supabase.from('usage_logs').insert({
    user_id: user.id,
    conversation_id: data.conversation_id ?? null,
    model: data.model,
    input_tokens: data.input_tokens,
    output_tokens: data.output_tokens,
    total_tokens: data.input_tokens + data.output_tokens,
    cost_usd: data.cost_usd ?? 0,
  })

  if (error) throw error
}
