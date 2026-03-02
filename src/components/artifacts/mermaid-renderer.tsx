import { useEffect, useRef, useState, useCallback } from 'react'
import DOMPurify from 'dompurify'
import { ZoomIn, ZoomOut, Maximize } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MermaidRendererProps {
  content: string
  streaming?: boolean
  onSvgReady?: (svg: string) => void
}

/**
 * 去除 AI 可能包裹的 markdown 代码围栏（```mermaid ... ```）
 * mermaid.render() 只接受纯 mermaid 语法
 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  // 匹配 ```mermaid / ```mmd / ``` 开头和 ``` 结尾
  const fenceRegex = /^```(?:mermaid|mmd)?\s*\n?([\s\S]*?)\n?\s*```$/
  const match = trimmed.match(fenceRegex)
  return match ? match[1].trim() : trimmed
}

/** 清理 mermaid.render() 在 document.body 中残留的孤儿元素 */
function cleanupMermaidOrphans(id: string) {
  // mermaid 会创建 id 为渲染 id 的元素，以及带 d- 前缀的错误容器
  const selectors = [
    `#${id}`,
    `#d${id}`,
    `[data-mermaid-id="${id}"]`,
  ]
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => el.remove())
    } catch {
      // selector 可能无效，忽略
    }
  }
  // 清理 body 下所有 mermaid 错误提示元素（class 含 error 且由 mermaid 创建）
  document.querySelectorAll('body > #d' + id).forEach((el) => el.remove())
}

const ZOOM_STEP = 0.15
const ZOOM_MIN = 0.3
const ZOOM_MAX = 3

let mermaidInitialized = false

export function MermaidRenderer({ content, streaming, onSvgReady }: MermaidRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgWrapperRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const renderIdRef = useRef<string>('')

  // 缩放控制
  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX)), [])
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN)), [])
  const zoomReset = useCallback(() => setZoom(1), [])

  // 鼠标滚轮缩放
  useEffect(() => {
    const wrapper = svgWrapperRef.current
    if (!wrapper || !svg) return

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        setZoom((z) => {
          const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
          return Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
        })
      }
    }

    wrapper.addEventListener('wheel', handleWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', handleWheel)
  }, [svg])

  // 内容变化时重置缩放
  useEffect(() => {
    setZoom(1)
  }, [content])

  useEffect(() => {
    if (streaming || !content.trim()) {
      setSvg('')
      setError(null)
      return
    }

    let cancelled = false

    const renderDiagram = async () => {
      setIsLoading(true)
      setError(null)

      // 清理上一次渲染可能遗留的 DOM
      if (renderIdRef.current) {
        cleanupMermaidOrphans(renderIdRef.current)
      }

      const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      renderIdRef.current = id

      try {
        const mermaid = (await import('mermaid')).default

        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: 'neutral',
            securityLevel: 'strict',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          })
          mermaidInitialized = true
        }

        const cleanContent = stripCodeFences(content)
        const { svg: renderedSvg } = await mermaid.render(id, cleanContent)

        if (!cancelled) {
          const cleanSvg = DOMPurify.sanitize(renderedSvg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          })
          setSvg(cleanSvg)
          onSvgReady?.(cleanSvg)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : '图表渲染失败'
          // 只取第一行有意义的错误信息，过滤掉 mermaid 版本信息等噪音
          const cleanMessage = message.split('\n')[0].replace(/mermaid version.*$/i, '').trim() || '图表语法错误，请检查 Mermaid 语法'
          setError(cleanMessage)
          setSvg('')
        }
      } finally {
        // 无论成功失败都清理 mermaid 在 body 中创建的临时元素
        cleanupMermaidOrphans(id)
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    renderDiagram()

    return () => {
      cancelled = true
      if (renderIdRef.current) {
        cleanupMermaidOrphans(renderIdRef.current)
      }
    }
  }, [content, streaming])

  if (streaming || isLoading) {
    return (
      <div className="h-full overflow-auto">
        <div className="relative">
          <div className="absolute top-3 right-3 flex items-center gap-1.5 text-xs text-accent">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            {streaming ? '生成中…' : '渲染中…'}
          </div>
          <pre className="p-4 text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </pre>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full flex flex-col">
        <div className="p-4 bg-error-light border-b border-error/20">
          <p className="text-sm text-error">{error}</p>
        </div>
        <div className="flex-1 overflow-auto">
          <pre className="p-4 text-[13px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </pre>
        </div>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-sm text-text-tertiary">无法渲染图表</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" ref={containerRef}>
      {/* 缩放工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light bg-background-secondary shrink-0">
        <span className="text-xs text-text-tertiary">
          {Math.round(zoom * 100)}%
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={zoomOut}
            disabled={zoom <= ZOOM_MIN}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              zoom <= ZOOM_MIN
                ? "text-text-tertiary/40 cursor-not-allowed"
                : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
            )}
            title="缩小 (Ctrl+滚轮)"
          >
            <ZoomOut size={14} strokeWidth={1.75} />
          </button>
          <button
            onClick={zoomReset}
            className="px-2 py-1 rounded-md text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
            title="重置缩放"
          >
            <Maximize size={14} strokeWidth={1.75} />
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= ZOOM_MAX}
            className={cn(
              "p-1.5 rounded-md transition-colors",
              zoom >= ZOOM_MAX
                ? "text-text-tertiary/40 cursor-not-allowed"
                : "text-text-tertiary hover:text-text-secondary hover:bg-surface-hover"
            )}
            title="放大 (Ctrl+滚轮)"
          >
            <ZoomIn size={14} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* 图表区域 */}
      <div
        ref={svgWrapperRef}
        className="flex-1 overflow-auto"
      >
        <div
          className="p-6 flex items-center justify-center min-h-full origin-center transition-transform duration-150"
          style={{ transform: `scale(${zoom})` }}
        >
          <div
            className="mermaid-container"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  )
}
