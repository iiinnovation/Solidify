import { useState, useRef, useEffect } from 'react'
import { Download, FileText, Globe, Image, Code, Presentation, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/stores/toast-store'
import type { ArtifactType } from '@/stores/chat-store'
import {
  getExportFormats,
  exportAsMarkdown,
  exportAsHtml,
  exportAsDocx,
  exportAsPdf,
  exportAsSvg,
  exportAsPng,
  exportChartAsPng,
  downloadBlob,
} from '@/lib/export'

const iconMap: Record<string, typeof FileText> = {
  FileText,
  Globe,
  Image,
  Code,
  Presentation,
}

interface ExportDropdownProps {
  content: string
  type: ArtifactType
  title: string
  contentRef?: React.RefObject<HTMLDivElement | null>
  svgString?: string
  chartRef?: React.RefObject<HTMLDivElement | null>
}

export function ExportDropdown({ content, type, title, contentRef, svgString, chartRef }: ExportDropdownProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const formats = getExportFormats(type)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const handleExport = async (formatId: string, extension: string) => {
    setLoading(formatId)
    try {
      const filename = `${title}${extension}`
      let blob: Blob

      switch (formatId) {
        case 'markdown':
          blob = exportAsMarkdown(content)
          break
        case 'html':
          if (type === 'code') {
            blob = new Blob([content], { type: 'text/html;charset=utf-8' })
          } else if (contentRef?.current) {
            blob = exportAsHtml(contentRef.current, title)
          } else {
            throw new Error('无法获取渲染内容')
          }
          break
        case 'docx':
          blob = await exportAsDocx(content, title)
          break
        case 'pdf':
          if (!contentRef?.current) throw new Error('无法获取渲染内容')
          blob = await exportAsPdf(contentRef.current, title)
          break
        case 'xml':
          // Draw.io XML 导出
          blob = new Blob([content], { type: 'application/xml;charset=utf-8' })
          break
        case 'svg':
          if (type === 'drawio') {
            // Draw.io SVG 导出需要通过 draw.io API
            toast.info('请在编辑模式中使用 draw.io 的导出功能')
            setOpen(false)
            return
          }
          if (!svgString) throw new Error('无法获取 SVG 内容')
          blob = exportAsSvg(svgString)
          break
        case 'png':
          if (type === 'drawio') {
            // Draw.io PNG 导出需要通过 draw.io API
            toast.info('请在编辑模式中使用 draw.io 的导出功能')
            setOpen(false)
            return
          }
          if (type === 'mermaid') {
            if (!svgString) throw new Error('无法获取 SVG 内容')
            blob = await exportAsPng(svgString)
          } else if (type === 'chart') {
            if (!chartRef?.current) throw new Error('无法获取图表容器')
            blob = await exportChartAsPng(chartRef.current)
          } else {
            throw new Error('不支持的 PNG 导出类型')
          }
          break
        case 'pptx': {
          const { parseSlidesDeck } = await import('@/lib/slide-types')
          const { loadTheme } = await import('@/lib/slide-themes')
          const { exportAsPptx } = await import('@/lib/slide-export')
          const deck = parseSlidesDeck(content)
          if (!deck) throw new Error('幻灯片数据解析失败')
          const theme = await loadTheme(deck.theme)
          blob = await exportAsPptx(deck, theme, title)
          break
        }
        default:
          throw new Error(`未知导出格式: ${formatId}`)
      }

      await downloadBlob(blob, filename)
      toast.success(`已导出 ${filename}`)
      setOpen(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : '导出失败'
      toast.error(msg)
    } finally {
      setLoading(null)
    }
  }

  // 只有一种格式时直接导出，不显示下拉
  if (formats.length <= 1) {
    const fmt = formats[0]
    if (!fmt) return null
    return (
      <button
        onClick={() => handleExport(fmt.id, fmt.extension)}
        disabled={loading !== null}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title={`导出为 ${fmt.label}`}
      >
        {loading ? <Loader2 size={14} strokeWidth={1.75} className="animate-spin" /> : <Download size={14} strokeWidth={1.75} />}
      </button>
    )
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="导出文件"
      >
        <Download size={14} strokeWidth={1.75} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded-lg border border-border bg-surface shadow-md py-1 min-w-[180px]">
          {formats.map((fmt) => {
            const Icon = iconMap[fmt.icon] ?? FileText
            const isLoading = loading === fmt.id
            return (
              <button
                key={fmt.id}
                onClick={() => handleExport(fmt.id, fmt.extension)}
                disabled={loading !== null}
                className={cn(
                  "w-full flex items-center gap-2.5 px-3 py-2 text-sm text-text-secondary transition-colors",
                  loading !== null ? "opacity-50 cursor-not-allowed" : "hover:bg-background-secondary hover:text-text-primary"
                )}
              >
                {isLoading ? (
                  <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-accent" />
                ) : (
                  <Icon size={14} strokeWidth={1.75} />
                )}
                <span className="flex-1 text-left">{fmt.label}</span>
                <span className="text-xs text-text-tertiary">{fmt.extension}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
