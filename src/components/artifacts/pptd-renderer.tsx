import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PptdRenderer } from '@/lib/pptd/renderer'
import { parsePptdArtifactContent } from '@/lib/pptd/artifact'
import { SlidesRenderer } from '@/components/artifacts/slides-renderer'
import { ScrollArea } from '@/components/ui/scroll-area'

interface PresentationArtifactRendererProps {
  content: string
  streaming?: boolean
}

/** Routes legacy eight-layout JSON and PPTD bundles through their compatible renderer. */
export function PresentationArtifactRenderer({ content, streaming }: PresentationArtifactRendererProps) {
  const project = useMemo(() => streaming ? null : parsePptdArtifactContent(content), [content, streaming])
  if (!project) return <SlidesRenderer content={content} streaming={streaming} />
  return <PptdDeckView project={project} />
}

function PptdDeckView({ project }: { project: NonNullable<ReturnType<typeof parsePptdArtifactContent>> }) {
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
