import { useState, useEffect, useRef, useCallback } from 'react'
import { FileText, Code, Presentation, GitGraph, Sparkles, Copy, BarChart3, Eye, Network } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MarkdownRenderer } from '@/components/artifacts/markdown-renderer'
import { MermaidRenderer } from '@/components/artifacts/mermaid-renderer'
import { ChartRenderer } from '@/components/artifacts/chart-renderer'
import { SlidesRenderer } from '@/components/artifacts/slides-renderer'
import { DrawioRenderer } from '@/components/artifacts/drawio-renderer'
import { ExportDropdown } from '@/components/artifacts/export-dropdown'
import { ErrorBoundary } from '@/components/shared/error-boundary'
import { cn } from '@/lib/utils'
import { useChatStore, type ArtifactType } from '@/stores/chat-store'
import { toast } from '@/stores/toast-store'

const typeIcons: Record<ArtifactType, typeof FileText> = {
  document: FileText,
  code: Code,
  slides: Presentation,
  mermaid: GitGraph,
  chart: BarChart3,
  drawio: Network,
}

interface ArtifactActionsProps {
  content: string
  type: ArtifactType
  title: string
  contentRef?: React.RefObject<HTMLDivElement | null>
  svgString?: string
  chartRef?: React.RefObject<HTMLDivElement | null>
}

function ArtifactActions({ content, type, title, contentRef, svgString, chartRef }: ArtifactActionsProps) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      toast.success('已复制到剪贴板')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleCopy}
        className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
        title="复制内容"
      >
        <Copy size={14} strokeWidth={1.75} />
      </button>
      <ExportDropdown
        content={content}
        type={type}
        title={title}
        contentRef={contentRef}
        svgString={svgString}
        chartRef={chartRef}
      />
    </div>
  )
}

/** 判断内容是否为 HTML（可在 iframe 中预览） */
function isHtmlContent(content: string): boolean {
  const trimmed = content.trim()
  return /^\s*<!doctype\s+html/i.test(trimmed) ||
    /^\s*<html[\s>]/i.test(trimmed) ||
    (trimmed.startsWith('<') && /<\/(html|body|div|head)>/i.test(trimmed))
}

/** 去除 AI 可能包裹的 markdown 代码围栏，返回 { language, code } */
function parseCodeContent(raw: string): { language: string; code: string } {
  const trimmed = raw.trim()
  const fenceRegex = /^```(\w*)\s*\n([\s\S]*?)\n?\s*```$/
  const match = trimmed.match(fenceRegex)
  if (match) {
    return { language: match[1] || 'text', code: match[2] }
  }
  return { language: 'text', code: trimmed }
}

function SourceView({ content, streaming }: { content: string; streaming?: boolean }) {
  const { language, code } = parseCodeContent(content)
  const markdownContent = '```' + language + '\n' + code + '\n```'

  return (
    <div className="h-full bg-[#1E1E1C] relative">
      {streaming && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 text-xs text-accent z-10">
          <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          生成中…
        </div>
      )}
      <ScrollArea className="h-full">
        <MarkdownRenderer content={markdownContent} className="[&_.group\\/code]:my-0 [&_.group\\/code]:rounded-none [&_pre]:!rounded-none" />
      </ScrollArea>
    </div>
  )
}

function CodeRenderer({ content, streaming }: { content: string; streaming?: boolean }) {
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview')
  const isHtml = !streaming && isHtmlContent(content)

  // content 变化时重置为 preview
  useEffect(() => {
    setViewMode('preview')
  }, [content])

  if (!isHtml) return <SourceView content={content} streaming={streaming} />

  return (
    <div className="h-full flex flex-col">
      {/* 预览/源码切换工具栏 */}
      <div className="flex items-center px-3 py-1.5 border-b border-border-light bg-background-secondary shrink-0">
        <div className="inline-flex items-center rounded-md border border-border-light bg-surface p-0.5 gap-0.5">
          <button
            onClick={() => setViewMode('preview')}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
              viewMode === 'preview'
                ? "bg-background text-text-primary shadow-sm"
                : "text-text-tertiary hover:text-text-secondary"
            )}
          >
            <Eye size={12} strokeWidth={1.75} />
            预览
          </button>
          <button
            onClick={() => setViewMode('source')}
            className={cn(
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors",
              viewMode === 'source'
                ? "bg-background text-text-primary shadow-sm"
                : "text-text-tertiary hover:text-text-secondary"
            )}
          >
            <Code size={12} strokeWidth={1.75} />
            源码
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0">
        {viewMode === 'preview' ? (
          <iframe
            sandbox="allow-scripts allow-modals"
            srcDoc={content}
            className="w-full h-full border-0"
            title="Code Preview"
          />
        ) : (
          <SourceView content={content} />
        )}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-xs">
        <div className="w-16 h-16 rounded-2xl bg-accent-light border border-accent/10 flex items-center justify-center mx-auto">
          <Sparkles size={24} strokeWidth={1.75} className="text-accent" />
        </div>
        <div>
          <p className="text-base font-medium text-text-primary">Artifacts 将在此处展示</p>
          <p className="text-sm text-text-tertiary mt-2 leading-relaxed">
            当 AI 生成文档、代码、图表或幻灯片时，内容会自动出现在这里
          </p>
        </div>
      </div>
    </div>
  )
}

export function ArtifactPanel({ conversationId }: { conversationId?: string }) {
  const { artifacts, activeArtifactId, setActiveArtifact } = useChatStore()
  const conversations = useChatStore((s) => s.conversations)
  const contentRef = useRef<HTMLDivElement>(null)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const [mermaidSvg, setMermaidSvg] = useState('')

  const handleMermaidSvgReady = useCallback((svg: string) => {
    setMermaidSvg(svg)
  }, [])

  // 切换 artifact 时重置 mermaid SVG 状态
  useEffect(() => {
    setMermaidSvg('')
  }, [activeArtifactId])

  // 按当前对话过滤 artifacts
  const conv = conversationId
    ? conversations.find((c) => c.id === conversationId)
    : undefined
  const messageIds = conv ? new Set(conv.messages.map((m) => m.id)) : null
  const filteredArtifacts = messageIds
    ? artifacts.filter((a) => messageIds.has(a.messageId))
    : []

  if (filteredArtifacts.length === 0) {
    return <EmptyState />
  }

  const activeArtifact = filteredArtifacts.find((a) => a.id === activeArtifactId) ?? filteredArtifacts[filteredArtifacts.length - 1]

  return (
    <div className="h-full flex flex-col bg-background">
      {/* 动态 Tab 栏 */}
      <div className="flex items-center justify-between h-11 border-b border-border-light bg-background-secondary px-2 shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          {filteredArtifacts.map((artifact) => {
            const Icon = typeIcons[artifact.type] || FileText
            const isActive = artifact.id === activeArtifact.id
            return (
              <button
                key={artifact.id}
                onClick={() => setActiveArtifact(artifact.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 text-small whitespace-nowrap rounded-t-sm border border-transparent transition-all shrink-0",
                  isActive
                    ? "border-border border-b-surface bg-surface text-text-primary font-medium"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-hover"
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
                <span className="max-w-[140px] truncate">{artifact.title}</span>
              </button>
            )
          })}
        </div>
        <ArtifactActions
          content={activeArtifact.content}
          type={activeArtifact.type}
          title={activeArtifact.title}
          contentRef={contentRef}
          svgString={activeArtifact.type === 'mermaid' ? mermaidSvg : undefined}
          chartRef={chartContainerRef}
        />
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0">
        <ErrorBoundary key={activeArtifact.id}>
          {activeArtifact.type === 'code' ? (
            <CodeRenderer content={activeArtifact.content} streaming={activeArtifact.streaming} />
          ) : activeArtifact.type === 'mermaid' ? (
            <MermaidRenderer content={activeArtifact.content} streaming={activeArtifact.streaming} onSvgReady={handleMermaidSvgReady} />
          ) : activeArtifact.type === 'chart' ? (
            <ChartRenderer content={activeArtifact.content} streaming={activeArtifact.streaming} chartRef={chartContainerRef} />
          ) : activeArtifact.type === 'slides' ? (
            <SlidesRenderer content={activeArtifact.content} streaming={activeArtifact.streaming} />
          ) : activeArtifact.type === 'drawio' ? (
            <DrawioRenderer content={activeArtifact.content} streaming={activeArtifact.streaming} />
          ) : (
            /* document 及任何未知类型均用 Markdown 渲染 */
            <ScrollArea className="h-full">
              <div className="p-6 max-w-3xl" ref={contentRef}>
                <MarkdownRenderer content={activeArtifact.content} />
              </div>
            </ScrollArea>
          )}
        </ErrorBoundary>
      </div>
    </div>
  )
}
