import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader2, PackageCheck, RefreshCw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ocrInstallationStatus, ocrPreparePackage, ocrCancelPreparation, ocrRetryPreparationCleanup, openFileDialog } from '@/lib/tauri'
import type { OcrInstallationSnapshot, OcrPackageSelection, PreparationPhase, PreparationStatus } from '@/lib/ocr-installation'

const phaseLabels: Record<PreparationPhase, string> = {
  authenticating: '正在认证发布描述', copying_archive: '正在复制归档', inspecting_archive: '正在检查归档',
  extracting_files: '正在展开并校验文件', verifying_components: '正在复核组件', cleaning_up: '正在回收暂存',
}
const statusLabels: Record<PreparationStatus, string> = {
  running: '正在校验组件包', stopping: '正在取消并回收', cleaning_up: '正在回收暂存',
  validated: '组件包校验通过，未安装', cancelled: '校验已取消', failed: '组件包校验失败', cleanup_failed: '暂存清理失败', cleaned: '暂存已清理',
}
const fields = [
  { key: 'descriptorPath', label: '发布描述', extension: 'json' },
  { key: 'signaturePath', label: '发布签名', extension: 'minisig' },
  { key: 'archivePath', label: '组件归档', extension: 'zip' },
] as const

function message(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') return error.message
  return '组件作业操作失败'
}

export function OcrPackagePreparation() {
  const [snapshot, setSnapshot] = useState<OcrInstallationSnapshot | null>(null)
  const [selection, setSelection] = useState<OcrPackageSelection>({ archivePath: '', descriptorPath: '', signaturePath: '' })
  const [queryFailed, setQueryFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (inFlight || !active) return
      if (timer) clearTimeout(timer)
      inFlight = true
      try {
        const state = await ocrInstallationStatus()
        if (active) { setSnapshot(state); setQueryFailed(false) }
      } catch {
        if (active) { setSnapshot(null); setQueryFailed(true) }
      } finally {
        inFlight = false
        if (active) timer = setTimeout(() => { void refresh() }, 1000)
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; if (timer) clearTimeout(timer); window.removeEventListener('focus', refresh) }
  }, [revision])

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setActionError(null)
    try { await action() } catch (error) { if (mounted.current) setActionError(message(error)) }
    finally {
      busyRef.current = false
      if (mounted.current) { setBusy(false); setRevision((value) => value + 1) }
    }
  }
  const job = snapshot?.job
  const active = job && ['running', 'stopping', 'cleaning_up'].includes(job.status)
  const blocked = !snapshot?.canPrepare || snapshot.closing || active || job?.status === 'cleanup_failed' || busy
  const progress = job?.progress
  const percent = progress?.totalBytes && progress.totalBytes > 0
    ? Math.min(100, Math.floor(progress.completedBytes / progress.totalBytes * 100)) : null

  return <div className="mt-3 min-w-0 border-t border-border/60 pt-3">
    <div className="flex items-center justify-between gap-2">
      <h4 className="text-xs font-medium text-text-primary">离线组件包校验</h4>
      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="刷新组件作业" title="刷新组件作业" onClick={() => setRevision((value) => value + 1)}><RefreshCw className="h-3.5 w-3.5" /></Button>
    </div>
    {snapshot?.unavailableReason && <p className="mt-1 break-words">{snapshot.unavailableReason}</p>}
    {snapshot?.closing && <p className="mt-1">应用正在退出</p>}
    {queryFailed && <p role="alert" className="mt-1 text-error">无法查询组件作业状态</p>}
    {!snapshot && !queryFailed && <p className="mt-1">正在查询组件作业…</p>}
    <div className="mt-2 space-y-1.5">
      {fields.map((field) => <div key={field.key} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)_1.75rem] items-center gap-2">
        <span>{field.label}</span>
        <span className="min-w-0 break-all text-text-tertiary">{selection[field.key].split(/[\\/]/).pop() || '未选择'}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={Boolean(blocked)} aria-label={`选择${field.label}`} title={`选择${field.label}`} onClick={() => void run(async () => {
          const path = await openFileDialog({ filters: [{ name: field.label, extensions: [field.extension] }] })
          if (mounted.current && typeof path === 'string') setSelection((value) => ({ ...value, [field.key]: path }))
        })}><FolderOpen className="h-3.5 w-3.5" /></Button>
      </div>)}
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={Boolean(blocked) || fields.some((field) => !selection[field.key])} onClick={() => void run(async () => {
        const id = await ocrPreparePackage(selection)
        if (mounted.current) setSnapshot((value) => value ? { ...value, job: { id, status: 'running', progress: null, error: null } } : value)
      })}>
        <PackageCheck className="mr-1.5 h-3.5 w-3.5" />校验组件包
      </Button>
      {job && active && <Button variant="ghost" size="sm" disabled={busy || job.status !== 'running'} onClick={() => void run(async () => { await ocrCancelPreparation(job.id) })}>
        <Square className="mr-1.5 h-3 w-3" />取消校验
      </Button>}
      {job?.status === 'cleanup_failed' && <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { await ocrRetryPreparationCleanup(job.id) })}>
        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />重试清理
      </Button>}
    </div>
    {job && <div className="mt-2 min-w-0" aria-live="polite">
      <p className="flex items-start gap-1.5">{active && <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin" />}<span className="break-words">{job.status === 'running' && progress ? phaseLabels[progress.phase] : statusLabels[job.status]}</span></p>
      {active && percent !== null && job.status === 'running' && <div className="mt-1.5 flex items-center gap-2">
        <progress className="h-1.5 min-w-0 flex-1 accent-accent" aria-label="当前阶段进度" max={100} value={percent} /><span className="w-10 shrink-0 text-right tabular-nums">{percent}%</span>
      </div>}
      {job.error && <p className="mt-1 break-words text-error">{job.error.message}</p>}
    </div>}
    {actionError && <p role="alert" className="mt-2 break-words text-error">{actionError}</p>}
  </div>
}
