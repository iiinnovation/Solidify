import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { PptdRenderer } from '@/lib/pptd/renderer'
import { parsePptdArtifactContentDetailed, type PptdArtifactParseDiagnostic } from '@/lib/pptd/artifact'
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
  const result = useMemo(() => streaming ? null : parsePptdArtifactContentDetailed(content), [content, streaming])
  const diagnostic = result?.project ? undefined : result?.diagnostics[0]

  useEffect(() => {
    if (!runId || !diagnostic) return
    recordParseFailure(runId, artifactId, diagnostic)
  }, [artifactId, diagnostic, runId])

  if (streaming) return <ScrollArea className="h-full"><pre className="p-4 text-xs text-text-secondary font-mono whitespace-pre-wrap break-all">{content}</pre></ScrollArea>
  if (!result?.project) return <ParseFailure diagnostic={diagnostic} />
  return <PptdDeckView project={result.project} />
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

function PptdDeckView({ project }: { project: NonNullable<ReturnType<typeof parsePptdArtifactContentDetailed>['project']> }) {
  const [rawPageIndex, setPageIndex] = useState(0)
  const pageIndex = Math.min(rawPageIndex, Math.max(0, project.pages.length - 1))
  if (project.pages.length === 0) return <div className="h-full flex items-center justify-center text-sm text-text-tertiary">PPTD 没有页面</div>
  return (
    <div className="h-full flex flex-col" data-pptd-artifact={project.title}>
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
