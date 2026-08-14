import { useEffect, useState } from 'react'
import { FileQuestion, LoaderCircle } from 'lucide-react'
import { extractText } from '@/lib/file-extractor'
import { readWorkspaceBytes } from '@/lib/tauri'
import { MarkdownRenderer } from '@/components/artifacts/markdown-renderer'

type Preview = { kind: 'text'; content: string } | { kind: 'image' | 'pdf'; url: string } | { kind: 'unsupported' }

export function FilePreview({ workspaceRoot, path }: { workspaceRoot: string; path: string | null }) {
  if (!path) return <div className="flex h-full items-center justify-center text-sm text-text-tertiary">选择文件以预览</div>
  return <LoadedFilePreview key={`${workspaceRoot}:${path}`} workspaceRoot={workspaceRoot} path={path} />
}

function LoadedFilePreview({ workspaceRoot, path }: { workspaceRoot: string; path: string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void readWorkspaceBytes(path, workspaceRoot).then(async (raw) => {
      const bytes = new Uint8Array(raw)
      const extension = path.split('.').pop()?.toLowerCase() ?? ''
      const mime = mimeType(extension)
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
        if (active) setPreview({ kind: mime === 'application/pdf' ? 'pdf' : 'image', url: objectUrl })
      } else if (isText(extension) || extension === 'docx') {
        const file = new File([bytes], path.split('/').pop() ?? path, { type: mime })
        const content = await extractText(file)
        if (active) setPreview({ kind: 'text', content })
      } else if (active) setPreview({ kind: 'unsupported' })
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [path, workspaceRoot])

  if (loading) return <div className="flex h-full items-center justify-center"><LoaderCircle size={20} className="animate-spin text-accent" /></div>
  if (error) return <div className="p-5 text-sm text-error">{error}</div>
  if (!preview || preview.kind === 'unsupported') return <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary"><FileQuestion size={28} /><span className="text-sm">此文件暂不支持预览</span></div>
  if (preview.kind === 'image') return <div className="flex h-full items-center justify-center overflow-auto p-5"><img src={preview.url} alt={path} className="max-h-full max-w-full object-contain" /></div>
  if (preview.kind === 'pdf') return <iframe title={path} src={preview.url} className="h-full w-full border-0" />
  if (preview.kind === 'text') return <div className="h-full overflow-auto p-6"><MarkdownRenderer content={preview.content} /></div>
  return null
}

function mimeType(extension: string): string {
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (extension === 'png') return 'image/png'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  return 'text/plain'
}

function isText(extension: string): boolean {
  return ['md', 'txt', 'csv', 'json', 'yaml', 'yml', 'toml', 'html', 'css', 'ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'java'].includes(extension)
}
