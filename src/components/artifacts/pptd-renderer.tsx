import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { PptdRenderer } from '@/lib/pptd/renderer'
import {
  parsePptdArtifactContentDetailed,
  type PptdArtifactParseDiagnostic,
  type PptdArtifactQualityReport,
} from '@/lib/pptd/artifact'
import { RunLedger, type JsonValue } from '@/lib/harness/ledger'
import { ScrollArea } from '@/components/ui/scroll-area'

interface PresentationArtifactRendererProps {
  content: string
  streaming?: boolean
  artifactId?: string
  runId?: string
}

/** All presentation formats are normalized to PPTD before rendering. */
export function PresentationArtifactRenderer({ content, streaming, artifactId, runId }: PresentationArtifactRendererProps) {
  const result = useMemo(() => parsePptdArtifactContentDetailed(content), [content])
  const diagnostic = result?.project || streaming ? undefined : result?.diagnostics[0]

  useEffect(() => {
    if (!runId || !diagnostic) return
    recordParseFailure(runId, artifactId, diagnostic)
  }, [artifactId, diagnostic, runId])

  if (result?.project) {
    return (
      <div className="relative h-full">
        {streaming && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-accent/20 bg-background/90 px-2 py-1 text-xs text-accent shadow-sm">
            <div className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
            生成中
          </div>
        )}
        <PptdDeckView project={result.project} qualityReport={result.qualityReport} />
      </div>
    )
  }
  if (streaming) return <ScrollArea className="h-full"><pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">{content}</pre></ScrollArea>
  return <ParseFailure diagnostic={diagnostic} />
}

function ParseFailure({ diagnostic }: { diagnostic?: PptdArtifactParseDiagnostic }) {
  const location = diagnostic && [
    diagnostic.line ? `第 ${diagnostic.line} 行` : '',
    diagnostic.column ? `第 ${diagnostic.column} 列` : '',
    diagnostic.position !== undefined ? `position ${diagnostic.position}` : '',
  ].filter(Boolean).join('，')
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6 text-error">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle size={16} />演示文稿解析失败</div>
        {diagnostic && <p className="mt-2 break-words text-xs leading-5">{diagnostic.message}{location ? `（${location}）` : ''}</p>}
        {diagnostic?.sourceLine !== undefined && <pre className="mt-3 overflow-auto whitespace-pre-wrap break-all border-l-2 border-error/40 pl-3 font-mono text-xs text-text-secondary">{diagnostic.sourceLine}</pre>}
      </div>
    </div>
  )
}

function recordParseFailure(runId: string, artifactId: string | undefined, diagnostic: PptdArtifactParseDiagnostic): void {
  try {
    const ledger = new RunLedger(runId)
    const duplicate = ledger.find('artifact.parse_failed').some((event) => {
      const payload = event.payload
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
      return payload.artifactId === (artifactId ?? null)
        && payload.stage === diagnostic.stage
        && payload.message === diagnostic.message
        && payload.position === (diagnostic.position ?? null)
    })
    if (duplicate) return
    ledger.append('artifact.parse_failed', {
      artifactId: artifactId ?? null,
      stage: diagnostic.stage,
      message: diagnostic.message,
      position: diagnostic.position ?? null,
      line: diagnostic.line ?? null,
      column: diagnostic.column ?? null,
      sourceLine: diagnostic.sourceLine ?? null,
    } satisfies Record<string, JsonValue>)
  } catch (error) {
    console.error('Unable to persist PPTD parse diagnostic:', error)
  }
}

function PptdDeckView({
  project,
  qualityReport,
}: {
  project: NonNullable<ReturnType<typeof parsePptdArtifactContentDetailed>['project']>
  qualityReport?: PptdArtifactQualityReport
}) {
  const [rawPageIndex, setPageIndex] = useState(0)
  const pageIndex = Math.min(rawPageIndex, Math.max(0, project.pages.length - 1))
  if (project.pages.length === 0) return <div className="h-full flex items-center justify-center text-sm text-text-tertiary">PPTD 没有页面</div>
  return (
    <div className="h-full flex flex-col" data-pptd-artifact={project.title}>
      {qualityReport && <QualityReport report={qualityReport} />}
      <ScrollArea className="flex-1 min-h-0 bg-black/5">
        <div className="min-h-full flex items-center justify-center p-4">
          <div className="w-full min-w-0 max-w-[960px] overflow-hidden rounded-lg bg-white shadow-lg">
            <PptdRenderer project={project} pageIndex={pageIndex} />
          </div>
        </div>
      </ScrollArea>
      <div className="h-10 shrink-0 flex items-center justify-between border-t border-border-light bg-background-secondary px-4">
        <button type="button" onClick={() => setPageIndex((index) => Math.max(0, index - 1))} disabled={pageIndex === 0} className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-hover disabled:opacity-30" aria-label="上一页"><ChevronLeft size={16} /></button>
        <span className="text-xs tabular-nums text-text-secondary">{pageIndex + 1} / {project.pages.length}</span>
        <button type="button" onClick={() => setPageIndex((index) => Math.min(project.pages.length - 1, index + 1))} disabled={pageIndex === project.pages.length - 1} className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-hover disabled:opacity-30" aria-label="下一页"><ChevronRight size={16} /></button>
      </div>
      <div data-pptd-capture-rack aria-hidden="true" style={{ position: 'fixed', left: -100000, top: 0, width: project.size[0], pointerEvents: 'none' }}>
        {project.pages.map((_page, index) => index === pageIndex ? null : <PptdRenderer key={index} project={project} pageIndex={index} />)}
      </div>
    </div>
  )
}

function QualityReport({ report }: { report: PptdArtifactQualityReport }) {
  const affected = [...report.fallbackPages, ...report.warningPages]
  const notices = report.notices ?? []
  const fallbackNumbers = report.fallbackPages.map((page) => page.pageIndex + 1)
  const summary = report.fallbackPages.length > 0
    ? `${report.fallbackPages.length} 页使用安全版式：第 ${fallbackNumbers.join('、')} 页`
    : report.warningPages.length > 0
      ? `${report.warningPages.length} 页存在非阻塞质量提示`
      : '视觉质量检查未完整执行'
  return (
    <details className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-text-primary" data-pptd-quality-report>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
        <AlertTriangle size={15} className="shrink-0 text-warning" />
        <span>{summary}</span>
      </summary>
      <div className="mt-2 max-h-28 space-y-1 overflow-auto pl-6 text-text-secondary">
        {notices.map((notice) => <p key={notice}>{notice}</p>)}
        {affected.map((page) => (
          <p key={`${page.status}-${page.pagePath}`}>
            第 {page.pageIndex + 1} 页：{page.reasons.join('；') || (page.status === 'fallback' ? '模型页面未通过质量检查' : '存在非阻塞提示')}
          </p>
        ))}
      </div>
    </details>
  )
}
