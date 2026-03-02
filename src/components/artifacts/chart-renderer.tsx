import { useMemo } from 'react'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { ScrollArea } from '@/components/ui/scroll-area'

interface ChartData {
  type: 'bar' | 'line' | 'pie' | 'area'
  data: Array<Record<string, unknown>>
  xKey?: string
  yKey?: string
  title?: string
}

const COLORS = [
  '#D4915E', // accent
  '#6B8E7B', // success
  '#C47067', // error
  '#7B8FA1', // muted blue
  '#9B7E6A', // warm brown
  '#8B9E82', // sage
  '#A18B7E', // taupe
  '#7A8B99', // slate
]

interface ChartRendererProps {
  content: string
  streaming?: boolean
  chartRef?: React.RefObject<HTMLDivElement | null>
}

/** 去除 AI 可能包裹的 markdown 代码围栏 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fenceRegex = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/
  const match = trimmed.match(fenceRegex)
  return match ? match[1].trim() : trimmed
}

export function ChartRenderer({ content, streaming, chartRef }: ChartRendererProps) {
  const { chartData, error } = useMemo(() => {
    if (streaming || !content.trim()) {
      return { chartData: null, error: null }
    }

    try {
      const parsed = JSON.parse(stripCodeFences(content)) as ChartData
      if (!parsed.type || !parsed.data || !Array.isArray(parsed.data)) {
        return { chartData: null, error: '无效的图表数据格式' }
      }
      return { chartData: parsed, error: null }
    } catch {
      return { chartData: null, error: 'JSON 解析失败' }
    }
  }, [content, streaming])

  if (streaming) {
    return (
      <ScrollArea className="h-full">
        <div className="relative">
          <div className="absolute top-3 right-3 flex items-center gap-1.5 text-xs text-accent">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            生成中…
          </div>
          <pre className="p-4 text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </pre>
        </div>
      </ScrollArea>
    )
  }

  if (error) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 bg-error-light border-b border-error/20">
          <p className="text-sm text-error">{error}</p>
        </div>
        <ScrollArea className="flex-1">
          <pre className="p-4 text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </pre>
        </ScrollArea>
      </div>
    )
  }

  if (!chartData) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-text-tertiary">无图表数据</p>
      </div>
    )
  }

  const { type, data, xKey = 'name', yKey = 'value', title } = chartData

  return (
    <div className="h-full flex flex-col p-6" ref={chartRef}>
      {title && (
        <h3 className="text-base font-medium text-text-primary mb-4 text-center">
          {title}
        </h3>
      )}
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          {type === 'bar' ? (
            <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E0DC" />
              <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#8C857D" />
              <YAxis tick={{ fontSize: 12 }} stroke="#8C857D" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#FFFDF9',
                  border: '1px solid #E5E0DC',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey={yKey} fill="#D4915E" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : type === 'line' ? (
            <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E0DC" />
              <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#8C857D" />
              <YAxis tick={{ fontSize: 12 }} stroke="#8C857D" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#FFFDF9',
                  border: '1px solid #E5E0DC',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Line
                type="monotone"
                dataKey={yKey}
                stroke="#D4915E"
                strokeWidth={2}
                dot={{ fill: '#D4915E', strokeWidth: 2 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          ) : type === 'area' ? (
            <AreaChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E0DC" />
              <XAxis dataKey={xKey} tick={{ fontSize: 12 }} stroke="#8C857D" />
              <YAxis tick={{ fontSize: 12 }} stroke="#8C857D" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#FFFDF9',
                  border: '1px solid #E5E0DC',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Area
                type="monotone"
                dataKey={yKey}
                stroke="#D4915E"
                fill="#D4915E"
                fillOpacity={0.2}
              />
            </AreaChart>
          ) : type === 'pie' ? (
            <PieChart margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <Pie
                data={data}
                dataKey={yKey}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                outerRadius="70%"
                label={({ name, percent }) => `${name ?? ''} ${((percent ?? 0) * 100).toFixed(0)}%`}
                labelLine={{ stroke: '#8C857D' }}
              >
                {data.map((_, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: '#FFFDF9',
                  border: '1px solid #E5E0DC',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
            </PieChart>
          ) : (
            <div className="h-full flex items-center justify-center">
              <p className="text-sm text-text-tertiary">不支持的图表类型: {type}</p>
            </div>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
