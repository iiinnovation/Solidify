import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { FolderTaskOcrProgress } from './folder-task-ocr-progress'
import { folderTaskClient } from '@/lib/folder-tasks'
import type { FolderTaskDetail, FolderTaskStatus } from '@/lib/folder-tasks/types'
import {
  projectFolderTaskChatStatus,
  type FolderTaskChatStatusIcon,
  type FolderTaskChatStatusTone,
} from '@/lib/folder-tasks/chat-status'

const ACTIVE_POLL_INTERVAL_MS = 1_500
const IDLE_POLL_INTERVAL_MS = 5_000

const activelyChangingStatuses = new Set<FolderTaskStatus>([
  'awaiting_plan_confirmation',
  'running',
  'awaiting_decision',
  'reviewing',
])

const toneClasses: Record<FolderTaskChatStatusTone, string> = {
  accent: 'border-accent/20 bg-accent-light text-accent',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  success: 'border-success/25 bg-success/10 text-success',
  danger: 'border-error/25 bg-error/10 text-error',
  neutral: 'border-border bg-background-secondary text-text-secondary',
}

const statusIcons: Record<FolderTaskChatStatusIcon, typeof ListTodo> = {
  task: ListTodo,
  sparkles: Sparkles,
  question: MessageCircleQuestion,
  success: CheckCircle2,
  paused: CirclePause,
  error: AlertCircle,
}

export function FolderTaskChatStatus({ taskId, onOpen }: { taskId: string; onOpen: () => void }) {
  const [task, setTask] = useState<FolderTaskDetail | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const refresh = async () => {
      try {
        const nextTask = await folderTaskClient.get(taskId)
        if (cancelled) return
        setTask(nextTask)
        setUnavailable(false)
        const delay = activelyChangingStatuses.has(nextTask.status)
          ? ACTIVE_POLL_INTERVAL_MS
          : IDLE_POLL_INTERVAL_MS
        timeout = setTimeout(refresh, delay)
      } catch {
        if (cancelled) return
        setUnavailable(true)
        timeout = setTimeout(refresh, IDLE_POLL_INTERVAL_MS)
      }
    }

    void refresh()
    return () => {
      cancelled = true
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }, [taskId])

  const view = task ? projectFolderTaskChatStatus(task) : null
  const Icon = unavailable ? AlertCircle : view ? statusIcons[view.icon] : ListTodo

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group relative flex w-full shrink-0 items-center gap-3 overflow-hidden border-b px-4 py-2.5 text-left transition-colors',
        unavailable ? toneClasses.danger : view ? toneClasses[view.tone] : 'border-accent/15 bg-accent-light text-accent',
      )}
      aria-label="打开文档任务详情"
    >
      <Icon size={17} className="shrink-0" strokeWidth={1.8} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-semibold">
            {unavailable ? '任务状态同步中断' : view?.title ?? '正在读取文档任务状态…'}
          </span>
          {view && <span className="shrink-0 text-[10px] tabular-nums opacity-75">{view.progress}%</span>}
        </div>
        <p className="mt-0.5 truncate text-[11px] text-text-secondary">
          {unavailable ? '当前显示可能已过期，稍后会自动重试。' : view?.detail ?? '正在同步持久化进度。'}
        </p>
        {!unavailable && view?.technicalNote && (
          <p className="mt-0.5 truncate text-[10px] text-text-tertiary">技术状态：{view.technicalNote}</p>
        )}
        <FolderTaskOcrProgress key={taskId} taskId={taskId} enabled={task?.id === taskId && task.status === 'running'} />
      </div>
      <ChevronRight size={15} className="shrink-0 opacity-55 transition-transform group-hover:translate-x-0.5" />
      {view && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-current/10" aria-hidden="true">
          <span className="block h-full bg-current transition-[width] duration-500" style={{ width: `${view.progress}%` }} />
        </span>
      )}
    </button>
  )
}
