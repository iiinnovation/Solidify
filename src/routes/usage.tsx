import { useState } from 'react'
import { BarChart3, TrendingUp, DollarSign, Activity } from 'lucide-react'
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import { useUsageStats } from '@/hooks/use-usage'
import { supabaseConfigured } from '@/lib/supabase'

const COLORS = ['#D4915E', '#5BA37C', '#5B8EC7', '#C75B5B', '#9B9590']

function StatCard({ icon: Icon, label, value, unit, trend }: {
  icon: typeof BarChart3
  label: string
  value: string | number
  unit?: string
  trend?: string
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="w-10 h-10 rounded-md bg-accent-light flex items-center justify-center">
          <Icon size={20} strokeWidth={1.75} className="text-accent" />
        </div>
        {trend && (
          <span className="text-xs text-success flex items-center gap-1">
            <TrendingUp size={12} strokeWidth={2} />
            {trend}
          </span>
        )}
      </div>
      <p className="text-sm text-text-tertiary mb-1">{label}</p>
      <p className="text-2xl font-semibold text-text-primary">
        {value}
        {unit && <span className="text-base text-text-secondary ml-1">{unit}</span>}
      </p>
    </div>
  )
}

export function UsagePage() {
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d'>('30d')

  // 计算日期范围
  const endDate = new Date().toISOString()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - (dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90))
  const startDateStr = startDate.toISOString()

  const { data: stats, isLoading } = useUsageStats({
    start_date: startDateStr,
    end_date: endDate,
  })

  if (!supabaseConfigured) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-warning-light border border-warning/10 flex items-center justify-center mx-auto">
            <BarChart3 size={24} strokeWidth={1.75} className="text-warning" />
          </div>
          <p className="text-base font-medium text-text-primary">未配置 Supabase</p>
          <p className="text-sm text-text-tertiary leading-relaxed">
            用量统计功能需要配置 Supabase 后端。请在 .env 文件中配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY。
          </p>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-text-tertiary">加载中...</div>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-text-tertiary">暂无数据</div>
      </div>
    )
  }

  // 格式化数字
  const formatNumber = (num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`
    return num.toString()
  }

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">用量统计</h1>
            <p className="text-sm text-text-tertiary mt-1">查看 AI 模型使用情况和成本分析</p>
          </div>
          <div className="inline-flex items-center rounded-md border border-border bg-surface p-0.5 gap-0.5">
            {(['7d', '30d', '90d'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  dateRange === range
                    ? 'bg-background text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {range === '7d' ? '最近 7 天' : range === '30d' ? '最近 30 天' : '最近 90 天'}
              </button>
            ))}
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={Activity}
            label="总 Token 消耗"
            value={formatNumber(stats.total_tokens)}
            unit="tokens"
          />
          <StatCard
            icon={DollarSign}
            label="总成本"
            value={formatCost(stats.total_cost)}
          />
          <StatCard
            icon={BarChart3}
            label="使用模型数"
            value={stats.by_model.length}
            unit="个"
          />
          <StatCard
            icon={TrendingUp}
            label="日均消耗"
            value={formatNumber(Math.round(stats.total_tokens / (stats.by_date.length || 1)))}
            unit="tokens"
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Token 消耗趋势 */}
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text-primary mb-4">Token 消耗趋势</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={stats.by_date}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis
                  dataKey="date"
                  stroke="var(--text-tertiary)"
                  fontSize={12}
                  tickFormatter={(date) => new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                />
                <YAxis stroke="var(--text-tertiary)" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                  }}
                  labelFormatter={(date) => new Date(date).toLocaleDateString('zh-CN')}
                />
                <Line
                  type="monotone"
                  dataKey="tokens"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  dot={{ fill: 'var(--accent)', r: 4 }}
                  name="Tokens"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* 模型使用分布 */}
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text-primary mb-4">模型使用分布</h3>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={stats.by_model}
                  dataKey="tokens"
                  nameKey="model"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={(entry: any) => `${entry.model}: ${formatNumber(entry.tokens)}`}
                >
                  {stats.by_model.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* 成本趋势 */}
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text-primary mb-4">成本趋势</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stats.by_date}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis
                  dataKey="date"
                  stroke="var(--text-tertiary)"
                  fontSize={12}
                  tickFormatter={(date) => new Date(date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}
                />
                <YAxis stroke="var(--text-tertiary)" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                  }}
                  labelFormatter={(date) => new Date(date).toLocaleDateString('zh-CN')}
                  formatter={(value) => formatCost(value as number)}
                />
                <Bar dataKey="cost" fill="var(--success)" name="成本 (USD)" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* 模型详细统计 */}
          <div className="rounded-lg border border-border bg-surface p-6">
            <h3 className="text-base font-semibold text-text-primary mb-4">模型详细统计</h3>
            <div className="space-y-3">
              {stats.by_model.map((model, index) => (
                <div key={model.model} className="flex items-center justify-between py-2 border-b border-border-light last:border-0">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                    />
                    <div>
                      <p className="text-sm font-medium text-text-primary">{model.model}</p>
                      <p className="text-xs text-text-tertiary">{model.count} 次调用</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-text-primary">{formatNumber(model.tokens)}</p>
                    <p className="text-xs text-text-tertiary">{formatCost(model.cost)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
