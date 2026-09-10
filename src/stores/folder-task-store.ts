import { create } from 'zustand'
import { folderTaskParseableFiles } from '@/lib/folder-tasks/parseability'
import { folderTaskClient } from '@/lib/folder-tasks'
import type {
  FolderTaskDetail,
  FolderTaskItem,
  FolderTaskPlan,
  FolderTaskPlanPreview,
  FolderTaskReviewUpdate,
  FolderTaskSummary,
} from '@/lib/folder-tasks'

interface FolderTaskState {
  tasks: FolderTaskSummary[]
  selectedTask: FolderTaskDetail | null
  planPreview: FolderTaskPlanPreview | null
  items: FolderTaskItem[]
  itemsHasMore: boolean
  itemsLoading: boolean
  itemStatus?: FolderTaskItem['status']
  loading: boolean
  mutating: boolean
  stoppingTaskId: string | null
  stopDelayed: boolean
  reportStopDelay: (taskId: string) => void
  error: string | null
  refresh: () => Promise<void>
  select: (taskId: string) => Promise<void>
  refreshItems: (status?: FolderTaskItem['status'], preserveRange?: boolean) => Promise<void>
  loadMoreItems: (status?: FolderTaskItem['status']) => Promise<void>
  createTask: (input: { name: string; goal: string; recipe: string; sourceMode?: 'documents' | 'folder' }) => Promise<FolderTaskDetail | null>
  startRecommended: () => Promise<FolderTaskDetail | null>
  previewPlan: (plan: FolderTaskPlan) => Promise<FolderTaskPlanPreview | null>
  confirmPlan: () => Promise<void>
  resolveDecision: (input: { decisionId: string; optionId: string; note?: string; applyToSimilar: boolean }) => Promise<void>
  reviewItems: (updates: FolderTaskReviewUpdate[]) => Promise<boolean>
  writeOutput: () => Promise<void>
  setStatus: (action: 'pause' | 'resume' | 'complete' | 'cancel') => Promise<void>
  deleteTask: () => Promise<boolean>
  clearError: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function listLoadedItems(taskId: string, status: FolderTaskItem['status'] | undefined, limit: number) {
  const pages = await Promise.all(Array.from({ length: Math.ceil(limit / 200) }, (_, index) =>
    folderTaskClient.listItems(taskId, status, index * 200, Math.min(200, limit - index * 200)),
  ))
  return pages.flat()
}

export const useFolderTaskStore = create<FolderTaskState>((set, get) => {
  let selectionRequest = 0
  let refreshRequest = 0
  let itemRequest = 0
  const deletedTaskIds = new Set<string>()
  const projectTask = (updated: FolderTaskDetail) => set((state) => ({
    tasks: [updated, ...state.tasks.filter((summary) => summary.id !== updated.id)],
    ...(state.selectedTask?.id === updated.id
      ? { selectedTask: updated, planPreview: null }
      : {}),
  }))
  const resolveTechnicalDecisions = async (initial: FolderTaskDetail): Promise<FolderTaskDetail> => {
    let task = initial
    for (const decision of task.decisions.filter((candidate) =>
      candidate.status === 'pending' && candidate.kind === 'unsupported_formats'
    )) {
      task = await folderTaskClient.resolveDecision({
        taskId: task.id,
        decisionId: decision.id,
        optionId: 'skip',
        applyToSimilar: true,
        expectedRevision: task.revision,
      })
      projectTask(task)
    }
    return task
  }
  const prepareRecommendedTask = async (initial: FolderTaskDetail): Promise<FolderTaskDetail> => {
    const task = await resolveTechnicalDecisions(initial)
    const unresolved = task.decisions.filter((decision) => decision.status === 'pending')
    if (unresolved.length > 0) {
      throw new Error('任务仍有需要通过对话确认的业务问题')
    }
    if (folderTaskParseableFiles(task.inventory) === 0) {
      throw new Error('所选目录中没有当前可解析的文档；请转换文件格式后重试')
    }
    return task
  }
  const mutate = async (operation: (task: FolderTaskDetail) => Promise<FolderTaskDetail>): Promise<boolean> => {
    const task = get().selectedTask
    if (!task || get().mutating) return false
    set({ mutating: true, error: null })
    try {
      const updated = await operation(task)
      set((state) => ({
        tasks: state.tasks.map((summary) => summary.id === updated.id ? updated : summary),
        ...(state.selectedTask?.id === updated.id
          ? { selectedTask: updated, planPreview: null }
          : {}),
      }))
      if (get().selectedTask?.id !== updated.id) return true
      try {
        await get().refreshItems(get().itemStatus, true)
      } catch (error) {
        set({ error: errorMessage(error) })
      }
      return true
    } catch (error) {
      set({ error: errorMessage(error) })
      try {
        const latest = await folderTaskClient.get(task.id)
        if (get().selectedTask?.id === task.id) set((state) => ({
          selectedTask: latest,
          planPreview: null,
          tasks: state.tasks.map((summary) => summary.id === latest.id ? latest : summary),
        }))
        if (get().selectedTask?.id === task.id) await get().refreshItems(get().itemStatus, true)
      } catch {
        // Preserve the original mutation error; a normal refresh can retry the projection.
      }
      return false
    } finally {
      set({ mutating: false })
    }
  }

  return {
    tasks: [],
    selectedTask: null,
    planPreview: null,
    items: [],
    itemsHasMore: false,
    itemsLoading: false,
    loading: false,
    mutating: false,
    stoppingTaskId: null,
    stopDelayed: false,
    reportStopDelay: (taskId) => { if (get().stoppingTaskId === taskId) set({ stopDelayed: true }) },
    error: null,
    clearError: () => set({ error: null }),
    refresh: async () => {
      const request = ++refreshRequest
      set({ loading: true, error: null })
      const selectedId = get().selectedTask?.id
      const status = get().itemStatus
      const itemsVersion = itemRequest
      const reloadItems = !get().itemsLoading
      const limit = Math.max(100, get().items.length)
      try {
        const [tasks, selectedTask, items] = await Promise.all([
          folderTaskClient.list(),
          selectedId ? folderTaskClient.get(selectedId) : Promise.resolve(null),
          selectedId && reloadItems
            ? listLoadedItems(selectedId, status, limit)
            : Promise.resolve([]),
        ])
        if (request !== refreshRequest) return
        set((state) => ({
          tasks,
          ...(selectedId && state.selectedTask?.id === selectedId
            ? { selectedTask, ...(reloadItems && itemsVersion === itemRequest && state.itemStatus === status ? { items, itemsHasMore: items.length === limit } : {}) }
            : {}),
        }))
      } catch (error) {
        if (request === refreshRequest) set({ error: errorMessage(error) })
      } finally {
        if (request === refreshRequest) set({ loading: false })
      }
    },
    select: async (taskId) => {
      if (deletedTaskIds.has(taskId)) return
      const request = ++selectionRequest
      const itemsVersion = ++itemRequest
      set({ loading: true, itemsLoading: true, error: null })
      try {
        const [selectedTask, items] = await Promise.all([
          folderTaskClient.get(taskId),
          folderTaskClient.listItems(taskId, get().itemStatus, 0, 100),
        ])
        if (request === selectionRequest) {
          set({ selectedTask, planPreview: null })
          if (itemsVersion === itemRequest) set({ items, itemsHasMore: items.length === 100 })
          else await get().refreshItems(get().itemStatus)
        }
      } catch (error) {
        if (request === selectionRequest && !deletedTaskIds.has(taskId)) {
          set({ error: errorMessage(error), selectedTask: null, items: [], itemsHasMore: false })
        }
      } finally {
        if (request === selectionRequest) set({ loading: false })
        if (itemsVersion === itemRequest) set({ itemsLoading: false })
      }
    },
    refreshItems: async (status, preserveRange = false) => {
      const request = ++itemRequest
      const limit = preserveRange && get().itemStatus === status ? Math.max(100, get().items.length) : 100
      const changed = get().itemStatus !== status
      set({ itemStatus: status, ...(changed ? { items: [], itemsHasMore: false } : {}) })
      const task = get().selectedTask
      if (!task) return
      set({ itemsLoading: true })
      try {
        const items = await listLoadedItems(task.id, status, limit)
        if (request === itemRequest && get().selectedTask?.id === task.id) set({ items, itemsHasMore: items.length === limit })
      } catch (error) {
        if (request === itemRequest) set({ error: errorMessage(error) })
      } finally {
        if (request === itemRequest) set({ itemsLoading: false })
      }
    },
    loadMoreItems: async (status) => {
      const task = get().selectedTask
      if (!task || !get().itemsHasMore || get().itemsLoading || get().itemStatus !== status) return
      const request = ++itemRequest
      set({ itemsLoading: true })
      try {
        const page = await folderTaskClient.listItems(task.id, status, get().items.length, 100)
        if (request !== itemRequest || get().selectedTask?.id !== task.id) return
        set((state) => ({ items: [...state.items, ...page.filter((item) => !state.items.some((existing) => existing.id === item.id))], itemsHasMore: page.length === 100 }))
      } catch (error) {
        if (request === itemRequest) set({ error: errorMessage(error) })
      } finally {
        if (request === itemRequest) set({ itemsLoading: false })
      }
    },
    createTask: async (input) => {
      set({ mutating: true, error: null })
      try {
        const created = await folderTaskClient.create(input)
        if (!created) return null
        itemRequest++
        set((state) => ({
          selectedTask: created,
          planPreview: null,
          items: [],
          itemsHasMore: false,
          itemsLoading: false,
          tasks: [created, ...state.tasks.filter((item) => item.id !== created.id)],
        }))
        try {
          const task = await resolveTechnicalDecisions(created)
          projectTask(task)
          return task
        } catch (error) {
          set({ error: errorMessage(error) })
          return get().selectedTask?.id === created.id ? get().selectedTask : created
        }
      } catch (error) {
        set({ error: errorMessage(error) })
        return null
      } finally {
        set({ mutating: false })
      }
    },
    startRecommended: async () => {
      const task = get().selectedTask
      if (!task || get().mutating) return null
      set({ mutating: true, error: null, planPreview: null })
      try {
        const updated = await prepareRecommendedTask(task)
        projectTask(updated)
        return updated
      } catch (error) {
        set({ error: errorMessage(error) })
        return null
      } finally {
        set({ mutating: false })
      }
    },
    previewPlan: async (plan) => {
      const task = get().selectedTask
      if (!task || get().mutating) return null
      set({ mutating: true, error: null, planPreview: null })
      try {
        const planPreview = await folderTaskClient.previewPlan(task.id, plan, task.revision)
        if (get().selectedTask?.id === task.id) set({ planPreview })
        return planPreview
      } catch (error) {
        set({ error: errorMessage(error) })
        return null
      } finally {
        set({ mutating: false })
      }
    },
    confirmPlan: async () => {
      await mutate((task) => {
        const preview = get().planPreview
        if (!preview) throw new Error('请先预览并核对任务计划')
        return folderTaskClient.confirmPlan(task.id, preview.confirmationToken, task.revision)
      })
    },
    resolveDecision: async (input) => {
      await mutate((task) => folderTaskClient.resolveDecision({
        taskId: task.id,
        expectedRevision: task.revision,
        ...input,
      }))
    },
    reviewItems: (updates) => mutate((task) => folderTaskClient.reviewItems(task.id, updates, task.revision)),
    writeOutput: async () => { await mutate((task) => folderTaskClient.writeOutput(task.id, task.revision)) },
    setStatus: async (action) => {
      await mutate(async (task) => {
        const stopping = action === 'pause' || action === 'cancel'
        if (stopping) set({ stoppingTaskId: task.id, stopDelayed: false })
        try {
          return await folderTaskClient.setStatus(task.id, action, task.revision)
        } finally {
          if (stopping && get().stoppingTaskId === task.id) set({ stoppingTaskId: null, stopDelayed: false })
        }
      })
    },
    deleteTask: async () => {
      const task = get().selectedTask
      if (!task || get().mutating) return false
      set({ mutating: true, error: null })
      try {
        await folderTaskClient.delete(task.id, task.revision)
        deletedTaskIds.add(task.id)
        selectionRequest++
        refreshRequest++
        itemRequest++
        set((state) => ({
          tasks: state.tasks.filter((candidate) => candidate.id !== task.id),
          loading: false,
          ...(state.selectedTask?.id === task.id
            ? {
                selectedTask: null,
                planPreview: null,
                items: [],
                itemsHasMore: false,
                itemsLoading: false,
              }
            : {}),
        }))
        return true
      } catch (error) {
        set({ error: errorMessage(error) })
        return false
      } finally {
        set({ mutating: false })
      }
    },
  }
})
