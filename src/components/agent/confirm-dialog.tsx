import { AlertTriangle, Check, FilePenLine, X } from 'lucide-react'
import type { ApprovalAnswer, ApprovalRequest } from '@/lib/harness/approval'
import { Button } from '@/components/ui/button'

interface ConfirmDialogProps {
  request: ApprovalRequest | readonly ApprovalRequest[] | null
  onAnswer: (requestId: string, answer: ApprovalAnswer) => void
}

export function ConfirmDialog({ request, onAnswer }: ConfirmDialogProps) {
  const requests: ApprovalRequest[] = request
    ? (Array.isArray(request) ? [...request] : [request])
    : []
  if (requests.length === 0) return null
  const multiple = requests.length > 1
  const answerAll = (answer: ApprovalAnswer) => {
    for (const item of requests) onAnswer(item.requestId, answer)
  }
  const allowAlways = requests.every((item) =>
    item.prompt.options.some((option) => option.decision === 'allow_always_in_run'))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-label={multiple ? `${requests.length} 个待确认操作` : requests[0].prompt.title}>
      <div className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-warning-light text-warning"><FilePenLine size={18} /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-text-primary">{multiple ? `${requests.length} 个待确认操作` : requests[0].prompt.title}</h2>
            <p className="text-xs text-text-tertiary">Agent 请求执行受保护操作</p>
          </div>
          <button type="button" title="关闭并全部拒绝" onClick={() => answerAll('deny')} className="p-1 text-text-tertiary hover:text-text-primary"><X size={18} /></button>
        </div>
        <div className="max-h-[60vh] divide-y divide-border-light overflow-y-auto px-5">
          {requests.map((item) => (
            <div key={item.requestId} className="py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  {multiple && <p className="mb-1 text-xs font-medium text-text-primary">{item.prompt.title}</p>}
                  <p className="break-words text-sm text-text-primary">{item.prompt.detail}</p>
                  <p className="mt-1 text-xs leading-relaxed text-text-secondary">{item.reason}</p>
                </div>
                {multiple && <div className="flex shrink-0 gap-1">
                  <button type="button" title="拒绝此操作" aria-label={`拒绝 ${item.prompt.title}`} onClick={() => onAnswer(item.requestId, 'deny')} className="p-1.5 text-error hover:bg-error-light"><X size={15} /></button>
                  <button type="button" title="允许此操作" aria-label={`允许 ${item.prompt.title}`} onClick={() => onAnswer(item.requestId, 'allow')} className="p-1.5 text-success hover:bg-success-light"><Check size={15} /></button>
                </div>}
              </div>
              {item.prompt.diff && <div className="mt-3 grid max-h-64 gap-2 overflow-auto rounded-md border border-border bg-background-secondary p-3 text-xs sm:grid-cols-2">
                {item.prompt.diff.before !== undefined && <div><p className="mb-1 font-medium text-error">覆盖前</p><pre className="whitespace-pre-wrap break-words text-text-secondary">{item.prompt.diff.before}</pre></div>}
                <div><p className="mb-1 font-medium text-success">写入后</p><pre className="whitespace-pre-wrap break-words text-text-secondary">{item.prompt.diff.after}</pre></div>
              </div>}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="ghost" onClick={() => answerAll('deny')}>{multiple ? '全部拒绝' : '拒绝'}</Button>
          {allowAlways && <Button variant="outline" onClick={() => answerAll('allow_always_in_run')}>本次运行内总是允许</Button>}
          <Button onClick={() => answerAll('allow')}>{multiple ? '全部允许' : '允许'}</Button>
        </div>
      </div>
    </div>
  )
}
