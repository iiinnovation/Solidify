import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Copy, FileQuestion, History, LoaderCircle } from 'lucide-react'
import { MarkdownRenderer } from '@/components/artifacts/markdown-renderer'
import { MermaidRenderer } from '@/components/artifacts/mermaid-renderer'
import { ChartRenderer } from '@/components/artifacts/chart-renderer'
import { SlidesRenderer } from '@/components/artifacts/slides-renderer'
import { DrawioRenderer } from '@/components/artifacts/drawio-renderer'
import { ExportDropdown } from '@/components/artifacts/export-dropdown'
import { ErrorBoundary } from '@/components/shared/error-boundary'
import { ScrollArea } from '@/components/ui/scroll-area'
import { VersionHistory } from './version-history'
import { readWorkspaceBytes, readWorkspaceFile } from '@/lib/tauri'
import { extractText } from '@/lib/file-extractor'
import { useDocumentStore } from '@/stores/document-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { toast } from '@/stores/toast-store'
import type { ArtifactType } from '@/stores/chat-store'

type BinaryPreview = { kind: 'image' | 'pdf'; url: string } | { kind: 'unsupported' }

export function DocumentViewer() {
  const workspaceRoot = useWorkspaceStore((state) => state.workspaceRoot)
  const selectedPath = useWorkspaceStore((state) => state.selectedPath)
  const entries = useWorkspaceStore((state) => state.entries)
  const activePath = useDocumentStore((state) => state.activePath)
  const documents = useDocumentStore((state) => state.documents)
  const setActivePath = useDocumentStore((state) => state.setActivePath)
  const upsertDocument = useDocumentStore((state) => state.upsertDocument)
  const path = activePath ?? selectedPath
  const document = path ? documents[path] : undefined
  const entryMtime = entries.find((entry) => entry.kind === 'file' && entry.path === path)?.modifiedAt
  const [loading, setLoading] = useState(false)
  const [binary, setBinary] = useState<BinaryPreview | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [preview, setPreview] = useState<{ content: string; label: string } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const [mermaidSvg, setMermaidSvg] = useState('')

  useEffect(() => {
    if (selectedPath && selectedPath !== activePath) setActivePath(selectedPath)
  }, [activePath, selectedPath, setActivePath])

  useEffect(() => {
    if (!path || !workspaceRoot || document?.streaming) return
    let active = true
    let objectUrl: string | null = null
    setLoading(true)
    setBinary(null)
    const extension = extensionOf(path)
    const load = async () => {
      if (isImage(extension) || extension === 'pdf' || extension === 'docx') {
        const bytes = new Uint8Array(await readWorkspaceBytes(path, workspaceRoot))
        if (extension === 'docx') {
          const content = await extractText(new File([bytes], fileName(path), { type: mimeType(extension) }))
          if (active) upsertDocument(makeDocument(path, content, document, entryMtime))
        } else {
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType(extension) }))
          if (active) setBinary({ kind: extension === 'pdf' ? 'pdf' : 'image', url: objectUrl })
        }
      } else if (isText(extension)) {
        const read = await readWorkspaceFile(path, workspaceRoot)
        if (active) upsertDocument(makeDocument(path, read.content ?? '', document, entryMtime))
      } else if (active) setBinary({ kind: 'unsupported' })
    }
    void load().catch((error) => { if (active) toast.error(error instanceof Error ? error.message : '无法读取文件') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
    // Reload only when the watcher reports a changed mtime or selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, workspaceRoot, entryMtime, document?.streaming, upsertDocument])

  useEffect(() => { setPreview(null); setHistoryOpen(false); setMermaidSvg('') }, [path])

  const content = preview?.content ?? document?.content ?? ''
  const type = document?.type ?? typeFromPath(path ?? '')
  const title = fileName(path ?? '')
  const onMermaidReady = useCallback((svg: string) => setMermaidSvg(svg), [])

  if (!path || !workspaceRoot) return <EmptyDocument />
  if (loading && !document) return <div className="flex h-full items-center justify-center"><LoaderCircle size={20} className="animate-spin text-accent" /></div>

  return (
    <div className="flex h-full min-w-0 bg-background">
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-light bg-background-secondary px-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={path}>{title}</span>
          {preview && <span className="rounded bg-info-light px-1.5 py-0.5 text-[11px] text-info">{preview.label}</span>}
          {document?.streaming && <span className="flex items-center gap-1 text-xs text-accent"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />生成中</span>}
          <button type="button" onClick={() => void navigator.clipboard.writeText(content).then(() => toast.success('已复制'))} aria-label="复制内容" title="复制内容" className="p-1.5 text-text-tertiary hover:text-text-primary"><Copy size={15} /></button>
          <ExportDropdown content={content} type={type} title={title} contentRef={contentRef} svgString={type === 'mermaid' ? mermaidSvg : undefined} chartRef={chartRef} />
          <button type="button" onClick={() => setHistoryOpen((value) => !value)} aria-label="版本历史" title="版本历史" className="p-1.5 text-text-tertiary hover:text-text-primary"><History size={15} /></button>
        </div>
        {document?.error && <div className="flex items-center gap-2 border-b border-error/20 bg-error-light px-3 py-2 text-xs text-error"><AlertTriangle size={14} />{document.error}</div>}
        <div className="min-h-0 flex-1" data-document-path={path} data-document-content>
          <ErrorBoundary key={`${path}:${preview?.label ?? 'current'}`}>
            {binary?.kind === 'image' ? <div className="flex h-full items-center justify-center overflow-auto p-5"><img src={binary.url} alt={path} className="max-h-full max-w-full object-contain" /></div>
              : binary?.kind === 'pdf' ? <iframe title={path} src={binary.url} className="h-full w-full border-0" />
              : binary?.kind === 'unsupported' ? <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary"><FileQuestion size={28} /><span className="text-sm">此文件暂不支持预览</span></div>
              : <DocumentContent type={type} content={content} streaming={document?.streaming} contentRef={contentRef} chartRef={chartRef} onMermaidReady={onMermaidReady} />}
          </ErrorBoundary>
        </div>
      </section>
      {historyOpen && <VersionHistory path={path} workspaceRoot={workspaceRoot} currentContent={document?.content ?? content} messageId={document?.messageId} onPreview={(next, label) => setPreview(next === null ? null : { content: next, label: label ?? '历史版本' })} onClose={() => { setHistoryOpen(false); setPreview(null) }} />}
    </div>
  )
}

function DocumentContent({ type, content, streaming, contentRef, chartRef, onMermaidReady }: { type: ArtifactType; content: string; streaming?: boolean; contentRef: React.RefObject<HTMLDivElement | null>; chartRef: React.RefObject<HTMLDivElement | null>; onMermaidReady: (svg: string) => void }) {
  if (type === 'mermaid') return <MermaidRenderer content={content} streaming={streaming} onSvgReady={onMermaidReady} />
  if (type === 'chart') return <ChartRenderer content={content} streaming={streaming} chartRef={chartRef} />
  if (type === 'slides') return <SlidesRenderer content={content} streaming={streaming} />
  if (type === 'drawio') return <DrawioRenderer content={content} streaming={streaming} />
  if (type === 'code') {
    if (!streaming && /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content)) return <iframe sandbox="allow-scripts allow-modals" srcDoc={content} className="h-full w-full border-0" title="代码预览" />
    const fenced = /^```/.test(content.trim()) ? content : `\`\`\`${languageFromContent(content)}\n${content}\n\`\`\``
    return <ScrollArea className="h-full bg-[#1E1E1C]"><MarkdownRenderer content={fenced} /></ScrollArea>
  }
  return <ScrollArea className="h-full"><div className="mx-auto max-w-3xl p-6" ref={contentRef}><MarkdownRenderer content={content} /></div></ScrollArea>
}

function EmptyDocument() {
  return <div className="flex h-full items-center justify-center bg-background"><div className="text-center"><FileQuestion size={28} className="mx-auto text-text-tertiary" /><p className="mt-3 text-sm font-medium">选择文件或生成交付物</p><p className="mt-1 text-xs text-text-tertiary">当前文档会在这里预览</p></div></div>
}

function makeDocument(path: string, content: string, previous: ReturnType<typeof useDocumentStore.getState>['documents'][string] | undefined, modifiedAt?: number) {
  return { path, title: fileName(path), type: previous?.type ?? typeFromPath(path), content, streaming: false, messageId: previous?.messageId, version: previous?.version ?? 1, modifiedAt }
}

function typeFromPath(path: string): ArtifactType {
  const extension = extensionOf(path)
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid'
  if (extension === 'drawio') return 'drawio'
  if (extension === 'pptd') return 'slides'
  if (extension === 'json' && path.includes('03-交付物/')) return 'chart'
  if (['html', 'css', 'js', 'jsx', 'ts', 'tsx', 'rs', 'py', 'go', 'java', 'sh'].includes(extension)) return 'code'
  return 'document'
}
function extensionOf(path: string) { return path.split('.').pop()?.toLowerCase() ?? '' }
function fileName(path: string) { return path.split('/').pop() ?? path }
function isImage(extension: string) { return ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) }
function isText(extension: string) { return ['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'java', 'sh', 'mmd', 'mermaid', 'drawio'].includes(extension) }
function mimeType(extension: string) { if (extension === 'pdf') return 'application/pdf'; if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; if (extension === 'png') return 'image/png'; if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'; if (extension === 'webp') return 'image/webp'; if (extension === 'gif') return 'image/gif'; return 'text/plain' }
function languageFromContent(content: string) { return /^\s*</.test(content) ? 'html' : 'text' }
