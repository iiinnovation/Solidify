import { useMemo, useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { RunLedger } from '@/lib/harness/ledger'

export function LedgerPanel({ runId, revision = 0 }: { runId: string; revision?: number }) {
  const [open, setOpen] = useState(false)
  const events = useMemo(() => {
    if (!open) return []
    // revision 只用于让账本增长时重新读取快照，不参与读取条件。
    void revision
    return new RunLedger(runId).events()
  }, [open, runId, revision])
  return (
    <div className="border-t border-border-light pt-2">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<BookOpen size={13} />运行账本
      </button>
      {open && <ol className="mt-2 max-h-72 space-y-1 overflow-auto border-l border-border pl-3">
        {events.map((event) => <li key={event.seq} className="py-1 text-[11px]"><div className="flex gap-2"><span className="w-6 text-right font-mono text-text-tertiary">{event.seq}</span><span className="font-medium text-text-primary">{event.type}</span><time className="ml-auto text-text-tertiary">{new Date(event.ts).toLocaleTimeString()}</time></div><pre className="mt-1 overflow-auto whitespace-pre-wrap text-text-tertiary">{JSON.stringify(event.payload, null, 2)}</pre></li>)}
        {events.length === 0 && <li className="py-2 text-xs text-text-tertiary">暂无持久事件</li>}
      </ol>}
    </div>
  )
}
