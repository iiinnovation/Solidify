import { AlertTriangle, FilePenLine, X } from 'lucide-react'
import type { ApprovalAnswer, ApprovalRequest } from '@/lib/harness/approval'
import { Button } from '@/components/ui/button'

export function ConfirmDialog({ request, onAnswer }: { request: ApprovalRequest | null; onAnswer: (requestId: string, answer: ApprovalAnswer) => void }) {
  if (!request) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label={request.prompt.title}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-warning-light text-warning"><FilePenLine size={18} /></span>
          <div className="min-w-0 flex-1"><h2 className="text-base font-semibold text-text-primary">{request.prompt.title}</h2><p className="text-xs text-text-tertiary">Agent 请求执行受保护操作</p></div>
          <button type="button" title="关闭并拒绝" onClick={() => onAnswer(request.requestId, 'deny')} className="p-1 text-text-tertiary hover:text-text-primary"><X size={18} /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning-light px-3 py-2.5"><AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" /><p className="text-sm text-text-primary">{request.prompt.detail}</p></div>
          <p className="text-xs leading-relaxed text-text-secondary">{request.reason}</p>
          {request.prompt.diff && <div className="grid max-h-64 gap-2 overflow-auto rounded-md border border-border bg-background-secondary p-3 text-xs sm:grid-cols-2">
            {request.prompt.diff.before !== undefined && <div><p className="mb-1 font-medium text-error">覆盖前</p><pre className="whitespace-pre-wrap break-words text-text-secondary">{request.prompt.diff.before}</pre></div>}
            <div><p className="mb-1 font-medium text-success">写入后</p><pre className="whitespace-pre-wrap break-words text-text-secondary">{request.prompt.diff.after}</pre></div>
          </div>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={() => onAnswer(request.requestId, 'deny')}>拒绝</Button>
          {request.prompt.options.some((option) => option.decision === 'allow_always_in_run') && <Button variant="outline" onClick={() => onAnswer(request.requestId, 'allow_always_in_run')}>本次运行内总是允许</Button>}
          <Button onClick={() => onAnswer(request.requestId, 'allow')}>允许</Button>
        </div>
      </div>
    </div>
  )
}
