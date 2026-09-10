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
  Trash2,
  XCircle,
} from 'lucide-react'
import { FolderTaskResult } from '@/components/agent/folder-task-result'
import { FolderTaskSource } from '@/components/agent/folder-task-source'
import { FolderTaskOcrStatus } from '@/components/agent/folder-task-ocr-status'
import { FolderTaskOcrProgress } from '@/components/agent/folder-task-ocr-progress'
import { Button } from '@/components/ui/button'
import { isTauri, listenFolderTaskExecutionStopping } from '@/lib/tauri'
import {
  FOLDER_TASK_STATUS_LABELS,
  folderTaskProcessedItems,
  folderTaskProgressPercent,
  inferFolderTaskRecipe,
  validateFolderTaskPlanRecipe,
  type FolderTaskDecision,
  type FolderTaskDetail,
  type FolderTaskItem,
  type FolderTaskPlan,
  type FolderTaskPlanPreview,
  type FolderTaskReviewUpdate,
} from '@/lib/folder-tasks'
import { formatFileSize } from '@/lib/file-extractor'
import { folderTaskParseableFiles } from '@/lib/folder-tasks/parseability'
import { useFolderTaskStore } from '@/stores/folder-task-store'
import { useChatStore } from '@/stores/chat-store'
import { useUIStore } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { cn } from '@/lib/utils'

const fieldClass = 'w-full rounded-lg border border-border-light bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent'

export function FolderTasksPage() {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const { tasks, selectedTask, planPreview, items, itemsHasMore, itemsLoading, loading, mutating, error, refresh, select, refreshItems, loadMoreItems, createTask, startRecommended, previewPlan, confirmPlan, resolveDecision, reviewItems, writeOutput, setStatus, deleteTask, clearError } = useFolderTaskStore()
  const [creating, setCreating] = useState(false)
  const stoppingTaskId = useFolderTaskStore((state) => state.stoppingTaskId)
  const stopDelayed = useFolderTaskStore((state) => state.stopDelayed)
  const [goal, setGoal] = useState('')
  const [itemFilter, setItemFilter] = useState<'all' | FolderTaskItem['status']>('all')

  useEffect(() => {
    if (isTauri) void refresh()
  }, [refresh])

  useEffect(() => {
    if (!isTauri) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listenFolderTaskExecutionStopping((payload) => {
      if (!disposed && payload.delayed) useFolderTaskStore.getState().reportStopDelay(payload.taskId)
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup }).catch(() => {
      // The status request still waits for backend confirmation if events fail.
    })
    return () => { disposed = true; unlisten?.() }
  }, [])

  useEffect(() => {
    if (taskId && selectedTask?.id !== taskId) void select(taskId)
  }, [select, selectedTask?.id, taskId])

  useEffect(() => {
    const selectedTaskId = selectedTask?.id
    if (!selectedTaskId) return
    void refreshItems(itemFilter === 'all' ? undefined : itemFilter)
  }, [itemFilter, refreshItems, selectedTask?.id])

  useEffect(() => {
    if (!selectedTask || !['running', 'awaiting_decision'].includes(selectedTask.status)) return
    const timer = window.setInterval(() => { void refresh() }, 2_000)
    return () => window.clearInterval(timer)
  }, [refresh, selectedTask])

  useEffect(() => {
    if (!taskId && !selectedTask && tasks[0]) navigate(`/folder-tasks/${tasks[0].id}`, { replace: true })
  }, [navigate, selectedTask, taskId, tasks])

  const pendingDecisions = useMemo(
    () => selectedTask?.decisions.filter((decision) => decision.status === 'pending') ?? [],
    [selectedTask?.decisions],
  )
  const technicalDecisions = pendingDecisions.filter((decision) => decision.kind === 'unsupported_formats')
  const businessDecisions = pendingDecisions.filter((decision) => decision.kind !== 'unsupported_formats')

  if (!isTauri) {
    return <CenteredNotice title="文档任务需要桌面端" description="浏览器无法持久授权访问本地文档文件夹，请在 Solidify 桌面客户端中使用。" />
  }

  const createFromSelection = async (sourceMode: 'documents' | 'folder') => {
    const request = goal.trim()
    if (!request) return
    const task = await createTask({
      name: request.length > 28 ? `${request.slice(0, 28)}…` : request,
      goal: request,
      recipe: inferFolderTaskRecipe(request),
      sourceMode,
    })
    if (!task) return
    setCreating(false)
    setGoal('')
    if (folderTaskParseableFiles(task.inventory) > 0 && ['awaiting_plan_confirmation', 'running'].includes(task.status)) {
      openAgentConversation(task.id, task.name, task.rootPath, navigate)
    }
    else navigate(`/folder-tasks/${task.id}`)
  }
  const submitCreate = (event: FormEvent) => {
    event.preventDefault()
    void createFromSelection('documents')
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border-light bg-background-secondary">
        <div className="flex items-center justify-between border-b border-border-light p-3">
          <div><h1 className="text-sm font-semibold text-text-primary">文档任务</h1><p className="text-xs text-text-tertiary">选择文档，对话处理</p></div>
          <Button size="icon" variant="ghost" onClick={() => setCreating((value) => !value)} aria-label="新建文档任务"><FolderPlus size={18} /></Button>
        </div>
        {creating && (
          <form onSubmit={submitCreate} className="space-y-2 border-b border-border-light p-3">
            <textarea className={cn(fieldClass, 'min-h-24 resize-y')} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="告诉 AI 如何处理这些文档，例如：提取每份合同的金额、双方名称和付款条件" autoFocus />
            <p className="text-[11px] leading-4 text-text-tertiary">选择多份文档或整个文件夹。系统会自动准备语义计划并进入对话。</p>
            <Button className="w-full" type="submit" disabled={mutating || !goal.trim()}>{mutating ? <Loader2 className="animate-spin" size={16} /> : '选择文档并开始对话'}</Button>
            <Button className="w-full" type="button" variant="ghost" disabled={mutating || !goal.trim()} onClick={() => void createFromSelection('folder')}>选择整个文件夹</Button>
          </form>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tasks.map((task) => (
            <button key={task.id} type="button" onClick={() => navigate(`/folder-tasks/${task.id}`)} className={cn('mb-1 w-full rounded-lg p-2.5 text-left transition-colors hover:bg-surface-hover', task.id === selectedTask?.id && 'bg-accent-light')}>
              <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-text-primary">{task.name}</span><span className="shrink-0 text-[10px] text-text-tertiary">{folderTaskProgressPercent(task)}%</span></div>
              <div className="mt-1 flex items-center justify-between text-xs text-text-tertiary"><span>{FOLDER_TASK_STATUS_LABELS[task.status]}</span><span>{task.inventory.files} 个文件</span></div>
            </button>
          ))}
          {!loading && tasks.length === 0 && <p className="px-3 py-12 text-center text-xs leading-5 text-text-tertiary">暂无任务。描述目标并选择文档后，AI 会直接在对话中开始处理。</p>}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {error && <div className="m-4 flex items-center justify-between rounded-lg border border-error/30 bg-error/5 px-4 py-3 text-sm text-error"><span>{error}</span><button onClick={clearError} aria-label="关闭错误"><XCircle size={16} /></button></div>}
        {selectedTask ? (
          <div className="mx-auto max-w-5xl space-y-5 p-5 lg:p-8">
            {stoppingTaskId === selectedTask.id && <div role="status" className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
              {stopDelayed ? '转换进程回收较慢，仍在等待停止确认；批次尚未释放，请勿重复启动。' : '正在停止任务，等待活动转换退出后确认。'}
            </div>}
            <TaskHeader
              task={selectedTask}
              busy={mutating}
              onStatus={async (action) => {
                if (['pause', 'cancel'].includes(action)) setTaskConversationAutoRun(selectedTask.id, false)
                await setStatus(action)
                if (action === 'resume') {
                  const resumed = useFolderTaskStore.getState().selectedTask
                  if (resumed?.id === selectedTask.id && ['awaiting_plan_confirmation', 'running'].includes(resumed.status)) {
                    openAgentConversation(resumed.id, resumed.name, resumed.rootPath, navigate)
                  }
                }
              }}
              onAgent={() => openAgentConversation(selectedTask.id, selectedTask.name, selectedTask.rootPath, navigate, false)}
              onExport={() => void writeOutput()}
              onDelete={async () => {
                if (!window.confirm(`确定删除任务“${selectedTask.name}”及其全部本地检查点吗？`)) return
                const taskToDelete = selectedTask.id
                if (await deleteTask()) {
                  deleteTaskConversations(taskToDelete)
                  navigate('/folder-tasks', { replace: true })
                }
              }}
            />
            <InventoryCard task={selectedTask} />
            <FolderTaskOcrProgress key={`progress-${selectedTask.id}`} taskId={selectedTask.id} enabled={selectedTask.status === 'running' || stoppingTaskId === selectedTask.id} />
            {((selectedTask.inventory.externalFiles ?? 0) > 0 || selectedTask.progress.awaitingExternalParser > 0)
              && <FolderTaskOcrStatus key={selectedTask.id} taskId={selectedTask.id} />}
            {businessDecisions.length > 0 && <section className="space-y-3"><SectionTitle title="AI 需要确认一个业务问题" subtitle="可以回到任务对话直接回答，也可以在这里选择" />{businessDecisions.map((decision) => <DecisionCard key={decision.id} decision={decision} busy={mutating} onResolve={resolveDecision} />)}</section>}
            {technicalDecisions.length > 0 && <TechnicalFilesCard task={selectedTask} />}
            {selectedTask.status === 'awaiting_plan_confirmation' && <>
              <RecommendedPlanCard task={selectedTask} busy={mutating} onStart={async () => {
                const started = await startRecommended()
                if (started && ['awaiting_plan_confirmation', 'running'].includes(started.status)) openAgentConversation(started.id, started.name, started.rootPath, navigate)
              }} />
              <details className="rounded-xl border border-border-light bg-surface p-4"><summary className="cursor-pointer text-sm font-medium text-text-secondary">高级设置</summary><div className="mt-4"><PlanCard key={`${selectedTask.id}:${selectedTask.revision}`} initialPlan={selectedTask.plan} preview={planPreview} busy={mutating} blocked={pendingDecisions.length > 0} onPreview={previewPlan} onConfirm={async () => {
                await confirmPlan()
                const started = useFolderTaskStore.getState().selectedTask
                if (started?.status === 'running') openAgentConversation(started.id, started.name, started.rootPath, navigate)
              }} /></div></details>
            </>}
            {selectedTask.activeBatch && <ActiveBatchCard task={selectedTask} />}
            <ResultsCard recipePlan={selectedTask.plan.recipePlan} itemsLoading={itemsLoading} taskStatus={selectedTask.status} items={items} hasMore={itemsHasMore} filter={itemFilter} onFilterChange={setItemFilter} onLoadMore={() => void loadMoreItems(itemFilter === 'all' ? undefined : itemFilter)} busy={mutating} onReview={async (updates) => {
              const task = selectedTask
              const saved = await reviewItems(updates)
              if (saved && updates.some((update) => update.action === 'retry')) {
                openAgentConversation(task.id, task.name, task.rootPath, navigate)
              }
              return saved
            }} />
            <RunsCard task={selectedTask} />
            <EventsCard events={selectedTask.recentEvents} />
          </div>
        ) : loading ? <CenteredNotice title="正在加载任务" description="正在读取本地检查点…" loading /> : <CenteredNotice title="选择或创建一个任务" description="大文件夹处理会以批次执行，遇到高影响歧义时才会暂停询问。" />}
      </main>
    </div>
  )
}

function openAgentConversation(taskId: string, taskName: string, taskRoot: string, navigate: ReturnType<typeof useNavigate>, start = true) {
  const chat = useChatStore.getState()
  let conversation = chat.conversations.find((item) => item.folderTaskId === taskId)
  let created = false
  if (!conversation) {
    const conversationId = chat.createConversation(`文档任务：${taskName}`, {
      folderTaskId: taskId,
      workspaceRoot: taskRoot,
    })
    conversation = useChatStore.getState().conversations.find((item) => item.id === conversationId)
    created = true
  }
  if (!conversation) return
  if (!conversation.workspaceRoot) {
    chat.bindConversationToWorkspace(conversation.id, {
      folderTaskId: taskId,
      workspaceRoot: taskRoot,
    })
  }
  if (start) chat.setFolderTaskAutoRun(conversation.id, true)
  if (created) {
    useUIStore.getState().setComposerDraft(conversation.id, { input: '', attachments: [], skill: null })
  }
  navigate(`/chat/${conversation.id}`)
}

function setTaskConversationAutoRun(taskId: string, enabled: boolean) {
  const chat = useChatStore.getState()
  for (const conversation of chat.conversations.filter((item) => item.folderTaskId === taskId)) {
    chat.setFolderTaskAutoRun(conversation.id, enabled)
  }
}

function deleteTaskConversations(taskId: string) {
  const chat = useChatStore.getState()
  for (const conversation of chat.conversations.filter((item) => item.folderTaskId === taskId)) {
    chat.deleteConversation(conversation.id)
  }
}

function TaskHeader({ task, busy, onStatus, onAgent, onExport, onDelete }: { task: FolderTaskDetail; busy: boolean; onStatus: (action: 'pause' | 'resume' | 'complete' | 'cancel') => Promise<void>; onAgent: () => void; onExport: () => void; onDelete: () => void }) {
  const canOpenConversation = task.status !== 'cancelled'
  const unresolved = task.progress.failed + task.progress.manualReview + task.progress.awaitingExternalParser
  return <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="mb-2 flex items-center gap-2"><StatusBadge status={task.status} />{task.pendingDecisions > 0 && <span className="text-xs text-warning">{task.pendingDecisions} 项待确认</span>}{unresolved > 0 && <span className="text-xs text-error">{unresolved} 项待处理异常</span>}</div><h2 className="text-2xl font-semibold text-text-primary">{task.name}</h2><p className="mt-1 text-sm text-text-secondary">{task.goal}</p><p className="mt-2 break-all text-xs text-text-tertiary">{task.rootPath}</p>{task.confirmedPlanHash && <p className="mt-1 break-all text-[10px] text-text-tertiary">计划 {task.confirmedPlanHash}</p>}{task.latestOutput && <p className={`mt-1 break-all text-xs ${task.latestOutput.isCurrent ? 'text-accent' : 'text-warning'}`}>{task.latestOutput.isCurrent ? '输出' : '输出已过期'} {task.latestOutput.relativePath} · SHA-256 {task.latestOutput.contentHash.slice(0, 12)}…</p>}</div><div className="flex shrink-0 flex-wrap gap-2">{canOpenConversation && <Button onClick={onAgent}><MessageSquare size={16} className="mr-1.5" />打开任务对话</Button>}{folderTaskProcessedItems(task) > 0 && task.status !== 'running' && <Button variant="outline" disabled={busy} onClick={onExport}><Download size={15} className="mr-1" />生成结果文件</Button>}{task.status === 'running' && <Button variant="outline" disabled={busy} onClick={() => void onStatus('pause')}><Pause size={15} className="mr-1" />暂停</Button>}{['paused', 'failed'].includes(task.status) && <Button disabled={busy} onClick={() => void onStatus('resume')}><Play size={15} className="mr-1" />恢复任务</Button>}{task.status === 'reviewing' && <Button disabled={busy || unresolved > 0 || (task.plan.output.autoWrite && !task.latestOutput?.isCurrent)} onClick={() => void onStatus('complete')}><CheckCircle2 size={15} className="mr-1" />确认 AI 结果</Button>}{!['completed', 'cancelled'].includes(task.status) && <Button variant="ghost" disabled={busy} onClick={() => void onStatus('cancel')}>取消任务</Button>}<Button variant="ghost" disabled={busy || task.status === 'running'} onClick={onDelete}><Trash2 size={15} className="mr-1" />删除</Button></div></header>
}

function InventoryCard({ task }: { task: FolderTaskDetail }) {
  const percent = folderTaskProgressPercent(task)
  const stats = [['文件', task.inventory.files], ['内置解析', task.inventory.readableFiles], ['需 OCR', task.inventory.externalFiles ?? 0], ['AI 已处理', task.progress.completed], ['待确认', task.progress.pendingDecision + task.progress.manualReview], ['待转换', task.progress.awaitingExternalParser], ['失败', task.progress.failed], ['已跳过', task.progress.skipped]]
  return <section className="rounded-xl border border-border-light bg-surface p-4"><div className="mb-3 flex items-center justify-between"><span className="text-sm font-medium text-text-primary">执行进度</span><span className="text-sm font-semibold text-accent">{percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-background-secondary"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} /></div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-6">{stats.map(([label, value]) => <div key={label} className="rounded-lg bg-background-secondary px-3 py-2"><div className="text-lg font-semibold text-text-primary">{value}</div><div className="text-xs text-text-tertiary">{label}</div></div>)}</div><div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-tertiary"><span>总大小 {formatFileSize(task.inventory.totalBytes)}</span><span>{task.inventory.directories} 个目录</span><span>{task.inventory.topLevelGroups} 个顶层分组</span></div>{task.inventory.truncated && <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning"><div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={13} />扫描未覆盖全部内容</div>{task.inventory.truncationReasons.map((reason) => <div key={reason} className="mt-1">{reason}</div>)}</div>}{task.inventory.warnings.map((warning) => <p key={warning} className="mt-2 flex items-center gap-1.5 text-xs text-warning"><AlertTriangle size={13} />{warning}</p>)}</section>
}

function RecommendedPlanCard({ task, busy, onStart }: { task: FolderTaskDetail; busy: boolean; onStart: () => Promise<void> }) {
  const labels: Record<string, string> = {
    'structured-extraction': '提取结构化信息与证据',
    'document-review': '按目标审查文档并给出处置建议',
    classification: '自动分类并汇总',
  }
  return <section className="rounded-xl border border-accent/25 bg-accent-light p-5">
    <SectionTitle title="扫描已完成，下一步由 AI 制定方案" subtitle="进入对话后，AI 会根据你的目标生成具体字段、审查规则或分类，再开始处理" />
    <div className="mt-4 grid gap-2 text-sm text-text-secondary sm:grid-cols-3"><span>{labels[task.recipe] ?? '处理文档'}</span><span>{task.inventory.readableFiles} 个内置解析文件 · {task.inventory.externalFiles ?? 0} 个 OCR 候选</span><span>完成后生成 {task.plan.output.format.toUpperCase()} 结果</span></div>
    {(task.inventory.externalFiles ?? 0) > 0 && <p className="mt-3 text-xs text-warning">图片将纳入处理方案，但能否读取取决于本机 OCR 组件。组件不可用时会保留为“待转换”，不会当作已处理或自动跳过。</p>}
    {task.inventory.attentionFiles > 0 && <p className="mt-3 text-xs text-warning">另有 {task.inventory.attentionFiles} 个文件暂不支持解析。系统会明确记录并跳过，不会要求你代替 AI 阅读。</p>}
    <Button className="mt-4" disabled={busy || folderTaskParseableFiles(task.inventory) === 0} onClick={() => void onStart()}>{busy ? <Loader2 size={16} className="animate-spin" /> : <><MessageSquare size={16} className="mr-1.5" />按推荐方案开始对话</>}</Button>
  </section>
}

function TechnicalFilesCard({ task }: { task: FolderTaskDetail }) {
  return <section className="rounded-xl border border-warning/25 bg-warning/5 p-4">
    <SectionTitle title="部分文件需要格式转换" subtitle="这是解析能力问题，不是需要你完成的人工审核" />
    <p className="mt-2 text-sm text-text-secondary">检测到 {task.inventory.attentionFiles} 个当前无法可靠读取的文件。按推荐方案启动时会先跳过并保留清单，其余文档继续由 AI 处理。</p>
  </section>
}

function PlanCard({ initialPlan, preview, onPreview, onConfirm, busy, blocked }: { initialPlan: FolderTaskPlan; preview: FolderTaskPlanPreview | null; onPreview: (plan: FolderTaskPlan) => Promise<FolderTaskPlanPreview | null>; onConfirm: () => Promise<void>; busy: boolean; blocked: boolean }) {
  const [plan, setPlan] = useState(initialPlan)
  const [recipePlanDraft, setRecipePlanDraft] = useState(() => JSON.stringify(initialPlan.recipePlan, null, 2))
  const update = <K extends keyof FolderTaskPlan>(key: K, value: FolderTaskPlan[K]) => setPlan((current) => ({ ...current, [key]: value }))
  const planWithRecipe = (): FolderTaskPlan | null => {
    try {
      const value = { ...plan, recipePlan: JSON.parse(recipePlanDraft) as FolderTaskPlan['recipePlan'] }
      const issues = validateFolderTaskPlanRecipe(value)
      if (issues.length > 0) { toast.error(issues[0]); return null }
      return value
    }
    catch { toast.error('RecipePlan 不是有效 JSON'); return null }
  }
  const previewMatches = preview != null && JSON.stringify(preview.plan) === JSON.stringify(planWithRecipeSilently(plan, recipePlanDraft))
  return <section className="rounded-xl border border-border-light bg-surface p-4">
    <SectionTitle title="确认执行计划" subtitle="先生成范围与规则预览；确认令牌会绑定完整计划和 SHA-256 inventory" />
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-xs text-text-secondary">每批最多文件数<input type="number" min={1} max={20} className={cn(fieldClass, 'mt-1')} value={plan.batchSize} onChange={(event) => update('batchSize', Number(event.target.value))} /></label>
      <label className="text-xs text-text-secondary">遇到歧义<select className={cn(fieldClass, 'mt-1')} value={plan.reviewPolicy} onChange={(event) => update('reviewPolicy', event.target.value as FolderTaskPlan['reviewPolicy'])}><option value="pause_on_ambiguity">立即暂停并询问</option><option value="collect_until_checkpoint">收集到批次检查点</option></select></label>
      <label className="text-xs text-text-secondary">快照方式<select className={cn(fieldClass, 'mt-1')} value={plan.snapshotMode} onChange={(event) => update('snapshotMode', event.target.value as FolderTaskPlan['snapshotMode'])}><option value="use_scanned_snapshot">使用已扫描快照</option><option value="refresh_before_run">确认前刷新并校验</option></select></label>
      <label className="text-xs text-text-secondary">完成策略<select className={cn(fieldClass, 'mt-1')} value={plan.completionPolicy} onChange={(event) => update('completionPolicy', event.target.value as FolderTaskPlan['completionPolicy'])}><option value="review_required">处理后确认 AI 结果</option><option value="complete_after_processing">无异常时自动完成</option></select></label>
      <label className="text-xs text-text-secondary">输出格式<select className={cn(fieldClass, 'mt-1')} value={plan.output.format} onChange={(event) => update('output', { ...plan.output, format: event.target.value as 'json' | 'xlsx', relativePath: plan.output.relativePath.replace(/\.(json|xlsx)$/i, `.${event.target.value}`) })}><option value="json">JSON</option><option value="xlsx">XLSX</option></select></label>
      <label className="text-xs text-text-secondary">输出行为<span className="mt-2 flex items-center gap-2"><input type="checkbox" checked={plan.output.autoWrite} onChange={(event) => update('output', { ...plan.output, autoWrite: event.target.checked })} />任务处理完自动生成</span><span className="mt-2 flex items-center gap-2"><input type="checkbox" checked={plan.output.overwrite} onChange={(event) => update('output', { ...plan.output, overwrite: event.target.checked })} />允许替换已有输出</span></label>
      <label className="text-xs text-text-secondary sm:col-span-2">输出相对路径<input className={cn(fieldClass, 'mt-1')} value={plan.output.relativePath} onChange={(event) => update('output', { ...plan.output, relativePath: event.target.value })} /></label>
      <label className="text-xs text-text-secondary">批次最大原始字节<input type="number" min={1} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxBatchBytes} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxBatchBytes: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary">批次预计字符上限<input type="number" min={1000} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxBatchEstimatedCharacters} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxBatchEstimatedCharacters: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary">单文件解析字符上限<input type="number" min={1000} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxParsedCharactersPerFile} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxParsedCharactersPerFile: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary">PDF 最大页数<input type="number" min={1} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxPdfPages} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxPdfPages: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary">压缩包最大条目数<input type="number" min={1} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxArchiveEntries} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxArchiveEntries: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary">压缩包最大展开字节<input type="number" min={1048576} className={cn(fieldClass, 'mt-1')} value={plan.resourceLimits.maxExpandedBytes} onChange={(event) => update('resourceLimits', { ...plan.resourceLimits, maxExpandedBytes: Number(event.target.value) })} /></label>
      <label className="text-xs text-text-secondary sm:col-span-2">处理扩展名（逗号分隔）<input className={cn(fieldClass, 'mt-1')} value={plan.includeExtensions.join(', ')} onChange={(event) => update('includeExtensions', event.target.value.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))} /></label>
      <label className="text-xs text-text-secondary sm:col-span-2">排除规则（每行一个 glob）<textarea className={cn(fieldClass, 'mt-1 min-h-20')} value={plan.exclusions.join('\n')} onChange={(event) => update('exclusions', event.target.value.split('\n').map((value) => value.trim()).filter(Boolean))} /></label>
      <label className="text-xs text-text-secondary sm:col-span-2">RecipePlan（版本化 JSON）<textarea className={cn(fieldClass, 'mt-1 min-h-56 font-mono text-xs')} value={recipePlanDraft} onChange={(event) => setRecipePlanDraft(event.target.value)} /></label>
    </div>
    {blocked && <p className="mt-3 text-xs text-warning">请先处理上方的扫描决策。</p>}
    {preview && <div className="mt-4 rounded-lg bg-background-secondary p-3 text-xs text-text-secondary"><div>选中 {preview.selectedFiles} 个文件（{formatFileSize(preview.selectedBytes)}），排除 {preview.excludedFiles} 个</div><div className="mt-1 break-all text-text-tertiary">inventory {preview.inventoryFingerprint}<br />confirmation {preview.confirmationToken}</div>{preview.warnings.map((warning) => <div key={warning} className="mt-2 text-warning">{warning}</div>)}{!previewMatches && <div className="mt-2 text-warning">计划已修改，请重新生成预览。</div>}</div>}
    <div className="mt-4 flex gap-2"><Button variant="outline" disabled={busy || blocked || plan.batchSize < 1 || plan.batchSize > 20 || plan.includeExtensions.length === 0} onClick={() => { const value = planWithRecipe(); if (value) void onPreview(value) }}>生成计划预览</Button><Button disabled={busy || blocked || !previewMatches || preview?.selectedFiles === 0} onClick={() => void onConfirm()}>确认绑定计划并开始</Button></div>
  </section>
}

function planWithRecipeSilently(plan: FolderTaskPlan, draft: string): FolderTaskPlan | null {
  try { return { ...plan, recipePlan: JSON.parse(draft) as FolderTaskPlan['recipePlan'] } } catch { return null }
}

function DecisionCard({ decision, busy, onResolve }: { decision: FolderTaskDecision; busy: boolean; onResolve: (input: { decisionId: string; optionId: string; note?: string; applyToSimilar: boolean }) => Promise<void> }) {
  const [optionId, setOptionId] = useState(decision.recommendedOptionId ?? decision.options[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [applyToSimilar, setApplyToSimilar] = useState(Boolean(decision.applyKey))
  return <article className="rounded-xl border border-warning/30 bg-warning/5 p-4"><h3 className="font-medium text-text-primary">{decision.title}</h3><p className="mt-1 text-sm leading-6 text-text-secondary">{decision.description}</p>{decision.affectedItemIds.length > 0 && <p className="mt-2 text-xs text-text-tertiary">影响 {decision.affectedItemIds.length} 个文件</p>}<div className="mt-3 space-y-2">{decision.options.map((option) => <label key={option.id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3', optionId === option.id ? 'border-accent bg-accent-light' : 'border-border-light bg-surface')}><input type="radio" name={decision.id} checked={optionId === option.id} onChange={() => setOptionId(option.id)} /><span><span className="text-sm font-medium text-text-primary">{option.label}{option.id === decision.recommendedOptionId && <span className="ml-2 text-xs text-accent">建议</span>}</span><span className="mt-0.5 block text-xs text-text-tertiary">{option.description}</span></span></label>)}</div><textarea value={note} onChange={(event) => setNote(event.target.value)} className={cn(fieldClass, 'mt-3 min-h-16')} placeholder="补充说明（可选）" />{decision.applyKey && <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={applyToSimilar} onChange={(event) => setApplyToSimilar(event.target.checked)} />将这个选择应用到同类情况</label>}<Button className="mt-3" disabled={busy || !optionId} onClick={() => void onResolve({ decisionId: decision.id, optionId, note: note.trim() || undefined, applyToSimilar })}>提交决策</Button></article>
}

function ResultsCard({ recipePlan, itemsLoading, taskStatus, items, hasMore, filter, onFilterChange, onLoadMore, busy, onReview }: { recipePlan: FolderTaskPlan['recipePlan']; itemsLoading: boolean; taskStatus: FolderTaskDetail['status']; items: FolderTaskItem[]; hasMore: boolean; filter: 'all' | FolderTaskItem['status']; onFilterChange: (filter: 'all' | FolderTaskItem['status']) => void; onLoadMore: () => void; busy: boolean; onReview: (updates: FolderTaskReviewUpdate[]) => Promise<boolean> }) {
  const canReview = ['reviewing', 'paused', 'failed', 'completed'].includes(taskStatus)
  return <section className="rounded-xl border border-border-light bg-surface p-4"><div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle title="AI 处理结果" subtitle={canReview ? '可直接修改已有结果；保存或重试后需重新确认，结果文件会随之更新' : '任务处理期间结果只读；完成或暂停后可以修正和重试'} /><select aria-label="结果状态筛选" className="rounded-lg border border-border-light bg-surface px-2 py-1 text-xs text-text-secondary" value={filter} onChange={(event) => onFilterChange(event.target.value as 'all' | FolderTaskItem['status'])}><option value="all">全部结果</option><option value="failed">处理失败</option><option value="manual_review">AI 结果待确认</option><option value="awaiting_external_parser">格式待转换</option><option value="pending_decision">业务问题待确认</option><option value="completed">AI 已完成</option><option value="skipped">已跳过</option><option value="pending">待处理</option></select></div>{items.length === 0 ? <p className="py-8 text-center text-xs text-text-tertiary">{itemsLoading ? '正在加载结果…' : '当前筛选下没有文件。'}</p> : <div className="mt-3 divide-y divide-border-light">{items.map((item) => <ResultItem key={item.id} recipePlan={recipePlan} item={item} busy={busy} canReview={canReview} onReview={onReview} />)}</div>}{hasMore && <Button className="mt-3 w-full" variant="outline" disabled={busy || itemsLoading} onClick={onLoadMore}>加载更多结果</Button>}</section>
}

function ResultItem({ recipePlan, item, busy, canReview, onReview }: { recipePlan: FolderTaskPlan['recipePlan']; item: FolderTaskItem; busy: boolean; canReview: boolean; onReview: (updates: FolderTaskReviewUpdate[]) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<unknown>(item.result)
  const hasAiResult = item.result != null && !['awaiting_external_parser', 'skipped'].includes(item.status)
  const canSkip = ['failed', 'awaiting_external_parser'].includes(item.status)
  const submitAccept = async () => {
    try {
      const result = draft
      const saved = await onReview([{ itemId: item.id, action: 'accept', result }])
      if (saved) setEditing(false)
    } catch (error) {
      toast.error(error instanceof SyntaxError ? '结果不是有效 JSON' : error instanceof Error ? error.message : '保存失败')
    }
  }
  return <div className="py-3"><div className="flex flex-wrap items-center justify-between gap-3"><span className="min-w-0 truncate text-sm text-text-primary">{item.relativePath}</span><div className="flex items-center gap-2"><ItemStatus status={item.status} />{canReview && hasAiResult && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(item.result); setEditing((value) => !value) }}>修正 AI 结果</Button>}{canReview && ['completed', 'failed', 'skipped', 'manual_review', 'awaiting_external_parser'].includes(item.status) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReview([{ itemId: item.id, action: 'retry' }])}><RotateCw size={13} className="mr-1" />让 AI 重试</Button>}{canReview && canSkip && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReview([{ itemId: item.id, action: 'skip', error: '用户选择跳过技术异常项' }])}>跳过</Button>}</div></div>{item.error && <p className="mt-1 text-xs text-error">{item.error}</p>}<FolderTaskSource provenance={item.provenance} />{editing ? <div className="mt-2 space-y-2"><FolderTaskResult recipePlan={recipePlan} value={draft} onChange={setDraft} /><div className="flex gap-2"><Button size="sm" disabled={busy} onClick={() => void submitAccept()}>校验并保存修正</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button></div></div> : item.result != null && <div className="mt-3 rounded-md bg-background-secondary p-3"><FolderTaskResult recipePlan={recipePlan} value={item.result} /></div>}</div>
}

function ActiveBatchCard({ task }: { task: FolderTaskDetail }) {
  const batch = task.activeBatch
  if (!batch) return null
  return <section className="rounded-xl border border-accent/20 bg-accent-light p-4"><SectionTitle title="当前批次" subtitle="批次由一个 Agent run 独占；中断、暂停或 lease 到期后会安全回队" /><div className="mt-3 grid gap-2 text-xs text-text-secondary sm:grid-cols-3"><span>批次 {batch.id}</span><span>{batch.itemIds.length} 个文件</span><span>租约至 {new Date(batch.leaseExpiresAt).toLocaleTimeString()}</span></div></section>
}

function RunsCard({ task }: { task: FolderTaskDetail }) {
  if (!task.recentRuns.length) return null
  return <section className="rounded-xl border border-border-light bg-surface p-4"><SectionTitle title="批处理运行" subtitle="最近 20 次有界 Agent run" /><div className="mt-3 space-y-2">{task.recentRuns.slice(0, 10).map((run) => <div key={run.runId} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="truncate text-text-secondary">{run.runId}</span><span className={run.status === 'failed' ? 'text-error' : 'text-text-tertiary'}>{run.status}{run.error ? ` · ${run.error}` : ''}</span></div>)}</div></section>
}

function EventsCard({ events }: { events: Array<{ seq: number; eventType: string; createdAt: number }> }) {
  return <section className="rounded-xl border border-border-light bg-surface p-4"><SectionTitle title="运行记录" subtitle="最近的持久化事件" /><div className="mt-3 space-y-2">{events.slice(0, 12).map((event) => <div key={event.seq} className="flex items-center justify-between text-xs"><span className="text-text-secondary">{event.eventType}</span><time className="text-text-tertiary">{new Date(event.createdAt).toLocaleString()}</time></div>)}</div></section>
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) { return <div><h3 className="text-sm font-semibold text-text-primary">{title}</h3><p className="mt-0.5 text-xs text-text-tertiary">{subtitle}</p></div> }
function StatusBadge({ status }: { status: keyof typeof FOLDER_TASK_STATUS_LABELS }) { return <span className="rounded-full bg-accent-light px-2 py-1 text-xs font-medium text-accent">{FOLDER_TASK_STATUS_LABELS[status]}</span> }
function ItemStatus({ status }: { status: FolderTaskItem['status'] }) { const labels: Record<FolderTaskItem['status'], string> = { pending: '待 AI 处理', processing: 'AI 处理中', completed: 'AI 已完成', skipped: '已跳过', failed: '处理失败', pending_decision: '业务问题待确认', manual_review: 'AI 结果待确认', awaiting_external_parser: '格式待转换' }; return <span className="shrink-0 text-xs text-text-tertiary">{labels[status]}</span> }
function CenteredNotice({ title, description, loading }: { title: string; description: string; loading?: boolean }) { return <div className="flex h-full items-center justify-center p-8"><div className="max-w-md text-center">{loading ? <Loader2 className="mx-auto mb-3 animate-spin text-accent" /> : <RotateCw className="mx-auto mb-3 text-text-tertiary" />}<h2 className="font-medium text-text-primary">{title}</h2><p className="mt-2 text-sm leading-6 text-text-tertiary">{description}</p></div></div> }
