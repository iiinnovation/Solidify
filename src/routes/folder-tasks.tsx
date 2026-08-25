import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderPlus,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RotateCw,
  XCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isTauri, saveFileDialog, writeTextFile } from '@/lib/tauri'
import {
  FOLDER_TASK_STATUS_LABELS,
  folderTaskClient,
  folderTaskProgressPercent,
  type FolderTaskDecision,
  type FolderTaskDetail,
  type FolderTaskItem,
  type FolderTaskPlan,
} from '@/lib/folder-tasks'
import { formatFileSize } from '@/lib/file-extractor'
import { useFolderTaskStore } from '@/stores/folder-task-store'
import { useChatStore } from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { cn } from '@/lib/utils'

const fieldClass = 'w-full rounded-lg border border-border-light bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent'

export function FolderTasksPage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const { tasks, selectedTask, items, loading, mutating, error, refresh, select, createTask, confirmPlan, resolveDecision, setStatus, clearError } = useFolderTaskStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [recipe, setRecipe] = useState('structured-extraction')

  useEffect(() => {
    if (isTauri) void refresh()
  }, [refresh])

  useEffect(() => {
    if (taskId && selectedTask?.id !== taskId) void select(taskId)
  }, [select, selectedTask?.id, taskId])

  useEffect(() => {
    if (!taskId && !selectedTask && tasks[0]) navigate(`/folder-tasks/${tasks[0].id}`, { replace: true })
  }, [navigate, selectedTask, taskId, tasks])

  const pendingDecisions = useMemo(
    () => selectedTask?.decisions.filter((decision) => decision.status === 'pending') ?? [],
    [selectedTask?.decisions],
  )

  if (!isTauri) {
    return <CenteredNotice title="文件夹任务需要桌面端" description="浏览器无法持久授权访问本地文件夹，请在 Solidify 桌面客户端中使用。" />
  }

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !goal.trim()) return
    const task = await createTask({ name: name.trim(), goal: goal.trim(), recipe })
    if (!task) return
    setCreating(false)
    setName('')
    setGoal('')
    navigate(`/folder-tasks/${task.id}`)
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-light bg-background-secondary">
        <div className="flex items-center justify-between border-b border-border-light p-3">
          <div><h1 className="text-sm font-semibold text-text-primary">文件夹任务</h1><p className="text-xs text-text-tertiary">持久化批处理</p></div>
          <Button size="icon" variant="ghost" onClick={() => setCreating((value) => !value)} aria-label="新建文件夹任务"><FolderPlus size={18} /></Button>
        </div>
        {creating && (
          <form onSubmit={submitCreate} className="space-y-2 border-b border-border-light p-3">
            <input className={fieldClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="任务名称" autoFocus />
            <textarea className={cn(fieldClass, 'min-h-20 resize-y')} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="希望如何处理这个文件夹？" />
            <select className={fieldClass} value={recipe} onChange={(event) => setRecipe(event.target.value)}>
              <option value="structured-extraction">结构化信息提取</option>
              <option value="document-review">批量文档审查</option>
              <option value="classification">文件分类与汇总</option>
            </select>
            <Button className="w-full" type="submit" disabled={mutating || !name.trim() || !goal.trim()}>{mutating ? <Loader2 className="animate-spin" size={16} /> : '选择文件夹并创建'}</Button>
          </form>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tasks.map((task) => (
            <button key={task.id} type="button" onClick={() => navigate(`/folder-tasks/${task.id}`)} className={cn('mb-1 w-full rounded-lg p-2.5 text-left transition-colors hover:bg-surface-hover', task.id === selectedTask?.id && 'bg-accent-light')}>
              <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-text-primary">{task.name}</span><span className="shrink-0 text-[10px] text-text-tertiary">{folderTaskProgressPercent(task)}%</span></div>
              <div className="mt-1 flex items-center justify-between text-xs text-text-tertiary"><span>{FOLDER_TASK_STATUS_LABELS[task.status]}</span><span>{task.inventory.files} 个文件</span></div>
            </button>
          ))}
          {!loading && tasks.length === 0 && <p className="px-3 py-12 text-center text-xs leading-5 text-text-tertiary">暂无任务。新建后会先扫描目录、展示计划，再开始处理。</p>}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {error && <div className="m-4 flex items-center justify-between rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error"><span>{error}</span><button onClick={clearError} aria-label="关闭错误"><XCircle size={16} /></button></div>}
        {selectedTask ? (
          <div className="mx-auto max-w-5xl space-y-5 p-5 lg:p-8">
            <TaskHeader task={selectedTask} busy={mutating} onStatus={setStatus} onAgent={() => openAgentConversation(selectedTask.id, selectedTask.name, navigate)} onExport={() => void exportTaskResults(selectedTask)} />
            <InventoryCard task={selectedTask} />
            {pendingDecisions.length > 0 && <section className="space-y-3"><SectionTitle title="需要你决定" subtitle="一次决策可以应用到同类文件" />{pendingDecisions.map((decision) => <DecisionCard key={decision.id} decision={decision} busy={mutating} onResolve={resolveDecision} />)}</section>}
            {selectedTask.status === 'awaiting_plan_confirmation' && <PlanCard key={`${selectedTask.id}:${selectedTask.revision}`} initialPlan={selectedTask.plan} busy={mutating} blocked={pendingDecisions.length > 0} onConfirm={(confirmedPlan) => void confirmPlan(confirmedPlan)} />}
            <ResultsCard items={items} />
            <EventsCard events={selectedTask.recentEvents} />
          </div>
        ) : loading ? <CenteredNotice title="正在加载任务" description="正在读取本地检查点…" loading /> : <CenteredNotice title="选择或创建一个任务" description="大文件夹处理会以批次执行，遇到高影响歧义时才会暂停询问。" />}
      </main>
    </div>
  )
}

function openAgentConversation(taskId: string, taskName: string, navigate: ReturnType<typeof useNavigate>) {
  const chat = useChatStore.getState()
  let conversation = chat.conversations.find((item) => item.folderTaskId === taskId)
  if (!conversation) {
    const conversationId = chat.createConversation(`文件夹任务：${taskName}`, {
      folderTaskId: taskId,
    })
    conversation = useChatStore.getState().conversations.find((item) => item.id === conversationId)
  }
  if (!conversation) return
  useUIStore.getState().setComposerDraft(conversation.id, {
    input: '继续当前文件夹任务。请读取持久化任务状态，按计划处理下一个批次并保存检查点。',
    attachments: [],
    skill: null,
  })
  navigate(`/chat/${conversation.id}`)
}

async function exportTaskResults(task: FolderTaskDetail): Promise<void> {
  try {
    const items: FolderTaskItem[] = []
    for (let offset = 0; ; offset += 200) {
      const page = await folderTaskClient.listItems(task.id, undefined, offset, 200)
      items.push(...page)
      if (page.length < 200) break
    }
    const safeName = task.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '文件夹任务'
    const path = await saveFileDialog({
      defaultName: `${safeName}_结果.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!path) return
    await writeTextFile(path, JSON.stringify({
      exportedAt: new Date().toISOString(),
      task: {
        id: task.id,
        name: task.name,
        goal: task.goal,
        rootPath: task.rootPath,
        status: task.status,
        plan: task.plan,
        inventory: task.inventory,
        progress: task.progress,
      },
      decisions: task.decisions,
      items,
    }, null, 2))
    toast.success(`已导出 ${items.length} 条文件结果`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导出失败')
  }
}

function TaskHeader({ task, busy, onStatus, onAgent, onExport }: { task: FolderTaskDetail; busy: boolean; onStatus: (action: 'pause' | 'resume' | 'complete' | 'cancel') => Promise<void>; onAgent: () => void; onExport: () => void }) {
  const canProcess = task.status === 'running'
  return <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="mb-2 flex items-center gap-2"><StatusBadge status={task.status} />{task.pendingDecisions > 0 && <span className="text-xs text-warning">{task.pendingDecisions} 项待决策</span>}</div><h2 className="text-2xl font-semibold text-text-primary">{task.name}</h2><p className="mt-1 text-sm text-text-secondary">{task.goal}</p><p className="mt-2 break-all text-xs text-text-tertiary">{task.rootPath}</p></div><div className="flex shrink-0 flex-wrap gap-2">{canProcess && <Button onClick={onAgent}><MessageSquare size={16} className="mr-1.5" />用 Agent 处理下一批</Button>}{task.progress.completed + task.progress.failed + task.progress.skipped > 0 && <Button variant="outline" onClick={onExport}><Download size={15} className="mr-1" />导出结果</Button>}{task.status === 'running' && <Button variant="outline" disabled={busy} onClick={() => void onStatus('pause')}><Pause size={15} className="mr-1" />暂停</Button>}{task.status === 'paused' && <Button disabled={busy} onClick={() => void onStatus('resume')}><Play size={15} className="mr-1" />继续</Button>}{task.status === 'reviewing' && <Button disabled={busy} onClick={() => void onStatus('complete')}><CheckCircle2 size={15} className="mr-1" />确认完成</Button>}{!['completed', 'cancelled'].includes(task.status) && <Button variant="ghost" disabled={busy} onClick={() => void onStatus('cancel')}>取消任务</Button>}</div></header>
}

function InventoryCard({ task }: { task: FolderTaskDetail }) {
  const percent = folderTaskProgressPercent(task)
  const stats = [['文件', task.inventory.files], ['可读', task.inventory.readableFiles], ['已完成', task.progress.completed], ['待决策', task.progress.pendingDecision], ['失败', task.progress.failed]]
  return <section className="rounded-xl border border-border-light bg-surface p-4"><div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium text-text-primary">执行进度</span><span className="text-sm font-semibold text-accent">{percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-background-secondary"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} /></div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">{stats.map(([label, value]) => <div key={label} className="rounded-lg bg-background-secondary px-3 py-2"><div className="text-lg font-semibold text-text-primary">{value}</div><div className="text-xs text-text-tertiary">{label}</div></div>)}</div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary"><span>总大小 {formatFileSize(task.inventory.totalBytes)}</span><span>{task.inventory.directories} 个目录</span><span>{task.inventory.topLevelGroups} 个顶层分组</span></div>{task.inventory.warnings.map((warning) => <p key={warning} className="mt-2 flex items-center gap-1.5 text-xs text-warning"><AlertTriangle size={13} />{warning}</p>)}</section>
}

function PlanCard({ initialPlan, onConfirm, busy, blocked }: { initialPlan: FolderTaskPlan; onConfirm: (plan: FolderTaskPlan) => void; busy: boolean; blocked: boolean }) {
  const [plan, setPlan] = useState(initialPlan)
  const update = <K extends keyof FolderTaskPlan>(key: K, value: FolderTaskPlan[K]) => setPlan((current) => ({ ...current, [key]: value }))
  return <section className="rounded-xl border border-border-light bg-surface p-4"><SectionTitle title="确认执行计划" subtitle="计划确认后才会允许 Agent 领取批次" /><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="text-xs text-text-secondary">每批文件数<input type="number" min={1} max={20} className={cn(fieldClass, 'mt-1')} value={plan.batchSize} onChange={(event) => update('batchSize', Number(event.target.value))} /></label><label className="text-xs text-text-secondary">遇到歧义<select className={cn(fieldClass, 'mt-1')} value={plan.reviewPolicy} onChange={(event) => update('reviewPolicy', event.target.value as FolderTaskPlan['reviewPolicy'])}><option value="pause_on_ambiguity">立即暂停并询问</option><option value="collect_until_checkpoint">收集到批次检查点</option></select></label><label className="text-xs text-text-secondary">基线方式<select className={cn(fieldClass, 'mt-1')} value={plan.baselineMode} onChange={(event) => update('baselineMode', event.target.value as FolderTaskPlan['baselineMode'])}><option value="incremental">按当前扫描增量执行</option><option value="full_rescan">执行前全量重扫描</option></select></label><label className="text-xs text-text-secondary">输出策略<select className={cn(fieldClass, 'mt-1')} value={plan.outputMode} onChange={(event) => update('outputMode', event.target.value as FolderTaskPlan['outputMode'])}><option value="review_before_write">先在任务中审阅</option><option value="export_only">仅导出结果</option></select></label></div>{blocked && <p className="mt-3 text-xs text-warning">请先处理上方的扫描决策。</p>}<Button className="mt-4" disabled={busy || blocked || plan.batchSize < 1 || plan.batchSize > 20} onClick={() => onConfirm(plan)}>确认计划并开始</Button></section>
}

function DecisionCard({ decision, busy, onResolve }: { decision: FolderTaskDecision; busy: boolean; onResolve: (input: { decisionId: string; optionId: string; note?: string; applyToSimilar: boolean }) => Promise<void> }) {
  const [optionId, setOptionId] = useState(decision.recommendedOptionId ?? decision.options[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [applyToSimilar, setApplyToSimilar] = useState(Boolean(decision.applyKey))
  return <article className="rounded-xl border border-warning/30 bg-warning/5 p-4"><h3 className="font-medium text-text-primary">{decision.title}</h3><p className="mt-1 text-sm leading-6 text-text-secondary">{decision.description}</p>{decision.affectedItemIds.length > 0 && <p className="mt-2 text-xs text-text-tertiary">影响 {decision.affectedItemIds.length} 个文件</p>}<div className="mt-3 space-y-2">{decision.options.map((option) => <label key={option.id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', optionId === option.id ? 'border-accent bg-accent-light' : 'border-border-light bg-surface')}><input type="radio" name={decision.id} checked={optionId === option.id} onChange={() => setOptionId(option.id)} /><span><span className="text-sm font-medium text-text-primary">{option.label}{option.id === decision.recommendedOptionId && <span className="ml-2 text-xs text-accent">建议</span>}</span><span className="mt-0.5 block text-xs text-text-tertiary">{option.description}</span></span></label>)}</div><textarea value={note} onChange={(event) => setNote(event.target.value)} className={cn(fieldClass, 'mt-3 min-h-16')} placeholder="补充说明（可选）" />{decision.applyKey && <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={applyToSimilar} onChange={(event) => setApplyToSimilar(event.target.checked)} />将这个选择应用到同类情况</label>}<Button className="mt-3" disabled={busy || !optionId} onClick={() => void onResolve({ decisionId: decision.id, optionId, note: note.trim() || undefined, applyToSimilar })}>提交决策</Button></article>
}

function ResultsCard({ items }: { items: FolderTaskItem[] }) {
  return <section className="rounded-xl border border-border-light bg-surface p-4"><SectionTitle title="文件结果" subtitle="优先显示异常项，最多 100 条" />{items.length === 0 ? <p className="py-8 text-center text-xs text-text-tertiary">还没有可展示的文件记录。</p> : <div className="mt-3 divide-y divide-border-light">{items.map((item) => <div key={item.id} className="py-3"><div className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-sm text-text-primary">{item.relativePath}</span><ItemStatus status={item.status} /></div>{item.error && <p className="mt-1 text-xs text-error">{item.error}</p>}{item.result != null && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-background-secondary p-2 text-xs text-text-secondary">{formatResult(item.result)}</pre>}</div>)}</div>}</section>
}

function EventsCard({ events }: { events: Array<{ seq: number; eventType: string; createdAt: number }> }) {
  return <section className="rounded-xl border border-border-light bg-surface p-4"><SectionTitle title="运行记录" subtitle="最近的持久化事件" /><div className="mt-3 space-y-2">{events.slice(0, 12).map((event) => <div key={event.seq} className="flex items-center justify-between text-xs"><span className="text-text-secondary">{event.eventType}</span><time className="text-text-tertiary">{new Date(event.createdAt).toLocaleString()}</time></div>)}</div></section>
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div><h3 className="text-sm font-semibold text-text-primary">{title}</h3><p className="mt-0.5 text-xs text-text-tertiary">{subtitle}</p></div> }
function StatusBadge({ status }: { status: keyof typeof FOLDER_TASK_STATUS_LABELS }) { return <span className="rounded-full bg-accent-light px-2 py-1 text-xs font-medium text-accent">{FOLDER_TASK_STATUS_LABELS[status]}</span> }
function ItemStatus({ status }: { status: FolderTaskItem['status'] }) { const labels: Record<FolderTaskItem['status'], string> = { pending: '待处理', processing: '处理中', completed: '已完成', skipped: '已跳过', failed: '失败', pending_decision: '待决策' }; return <span className="shrink-0 text-xs text-text-tertiary">{labels[status]}</span> }
function formatResult(result: unknown): string { return typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
function CenteredNotice({ title, description, loading }: { title: string; description: string; loading?: boolean }) { return <div className="flex h-full items-center justify-center p-8"><div className="max-w-md text-center">{loading ? <Loader2 className="mx-auto mb-3 animate-spin text-accent" /> : <RotateCw className="mx-auto mb-3 text-text-tertiary" />}<h2 className="font-medium text-text-primary">{title}</h2><p className="mt-2 text-sm leading-6 text-text-tertiary">{description}</p></div></div> }
