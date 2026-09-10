import {
  folderTaskProcessedItems,
  folderTaskProgressPercent,
  type FolderTaskDetail,
} from './types'

export type FolderTaskChatStatusTone = 'accent' | 'warning' | 'success' | 'danger' | 'neutral'
export type FolderTaskChatStatusIcon = 'task' | 'sparkles' | 'question' | 'success' | 'paused' | 'error'

export interface FolderTaskChatStatusView {
  title: string
  detail: string
  progress: number
  tone: FolderTaskChatStatusTone
  icon: FolderTaskChatStatusIcon
  technicalNote?: string
}

export function projectFolderTaskChatStatus(task: FolderTaskDetail): FolderTaskChatStatusView {
  const processed = folderTaskProcessedItems(task)
  const total = task.inventory.files
  const progress = folderTaskProgressPercent(task)
  const technicalNotes: string[] = []

  if (task.inventory.attentionFiles > 0 && task.progress.awaitingExternalParser === 0) {
    technicalNotes.push(`${task.inventory.attentionFiles} 个不支持解析的文件已自动记录并跳过`)
  }
  if (task.progress.awaitingExternalParser > 0) technicalNotes.push(`${task.progress.awaitingExternalParser} 个文件等待外部解析器`)
  const technicalNote = technicalNotes.length > 0 ? technicalNotes.join('，') : undefined

  switch (task.status) {
    case 'awaiting_plan_confirmation':
      return {
        title: 'AI 正在整理处理方案',
        detail: '会根据你的目标识别字段、规则和输出方式，然后直接开始处理。',
        progress,
        tone: 'accent',
        icon: 'sparkles',
        technicalNote,
      }
    case 'running':
      return {
        title: `已处理 ${processed}/${total} · 成功 ${task.progress.completed} · 跳过 ${task.progress.skipped}`,
        detail: task.progress.processing > 0
          ? `${task.progress.processing} 个处理中，${task.progress.pending} 个等待处理。`
          : `${task.progress.pending} 个等待处理。`,
        progress,
        tone: 'accent',
        icon: 'task',
        technicalNote,
      }
    case 'awaiting_decision':
      return {
        title: '等待你在对话中补充信息',
        detail: '直接回复上一个问题即可，AI 会理解回答并继续处理。',
        progress,
        tone: 'warning',
        icon: 'question',
        technicalNote,
      }
    case 'reviewing':
      return {
        title: 'AI 已生成结果，等待你的确认',
        detail: '请在对话中提出修改，或回复“结果没问题，完成任务”。',
        progress,
        tone: 'warning',
        icon: 'question',
        technicalNote,
      }
    case 'completed':
      return {
        title: `任务已完成 · 成功 ${task.progress.completed} · 跳过 ${task.progress.skipped} · 失败 ${task.progress.failed}`,
        detail: task.latestOutput?.isCurrent
          ? `输出已保存至 ${task.latestOutput.relativePath}`
          : '结果已经确认并保存。',
        progress,
        tone: 'success',
        icon: 'success',
        technicalNote,
      }
    case 'paused':
      return {
        title: `任务已暂停 · ${processed}/${total}`,
        detail: '打开任务详情可恢复处理。',
        progress,
        tone: 'neutral',
        icon: 'paused',
        technicalNote,
      }
    case 'failed':
      return {
        title: '任务处理失败',
        detail: '打开任务详情查看失败原因和可重试项目。',
        progress,
        tone: 'danger',
        icon: 'error',
        technicalNote,
      }
    case 'cancelled':
      return {
        title: '任务已取消',
        detail: `取消前已处理 ${processed}/${total} 个文档。`,
        progress,
        tone: 'neutral',
        icon: 'paused',
        technicalNote,
      }
  }
}
