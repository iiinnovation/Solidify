import { create } from 'zustand'
import { folderTaskClient } from '@/lib/folder-tasks'
import type {
  FolderTaskDetail,
  FolderTaskItem,
  FolderTaskPlan,
  FolderTaskSummary,
} from '@/lib/folder-tasks'

interface FolderTaskState {
  tasks: FolderTaskSummary[]
  selectedTask: FolderTaskDetail | null
  items: FolderTaskItem[]
  loading: boolean
  mutating: boolean
  error: string | null
  refresh: () => Promise<void>
  select: (taskId: string) => Promise<void>
  refreshItems: (status?: FolderTaskItem['status']) => Promise<void>
  createTask: (input: { name: string; goal: string; recipe: string }) => Promise<FolderTaskDetail | null>
  confirmPlan: (plan: FolderTaskPlan) => Promise<void>
  resolveDecision: (input: { decisionId: string; optionId: string; note?: string; applyToSimilar: boolean }) => Promise<void>
  setStatus: (action: 'pause' | 'resume' | 'complete' | 'cancel') => Promise<void>
  clearError: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useFolderTaskStore = create<FolderTaskState>((set, get) => {
  let selectionRequest = 0
  const mutate = async (operation: (task: FolderTaskDetail) => Promise<FolderTaskDetail>) => {
    const task = get().selectedTask
    if (!task || get().mutating) return
    set({ mutating: true, error: null })
    try {
      const updated = await operation(task)
      set((state) => ({
        selectedTask: updated,
        tasks: state.tasks.map((summary) => summary.id === updated.id ? updated : summary),
      }))
      try {
        const items = await folderTaskClient.listItems(updated.id, undefined, 0, 100)
        if (get().selectedTask?.id === updated.id) set({ items })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    } catch (error) {
      set({ error: errorMessage(error) })
    } finally {
      set({ mutating: false })
    }
  }

  return {
    tasks: [],
    selectedTask: null,
    items: [],
    loading: false,
    mutating: false,
    error: null,
    clearError: () => set({ error: null }),
    refresh: async () => {
      set({ loading: true, error: null })
      const selectedId = get().selectedTask?.id
      try {
        const [tasks, selectedTask, items] = await Promise.all([
          folderTaskClient.list(),
          selectedId ? folderTaskClient.get(selectedId) : Promise.resolve(null),
          selectedId
            ? folderTaskClient.listItems(selectedId, undefined, 0, 100)
            : Promise.resolve([]),
        ])
        set((state) => ({
          tasks,
          ...(selectedId && state.selectedTask?.id === selectedId
            ? { selectedTask, items }
            : {}),
        }))
      } catch (error) {
        set({ error: errorMessage(error) })
      } finally {
        set({ loading: false })
      }
    },
    select: async (taskId) => {
      const request = ++selectionRequest
      set({ loading: true, error: null })
      try {
        const [selectedTask, items] = await Promise.all([
          folderTaskClient.get(taskId),
          folderTaskClient.listItems(taskId, undefined, 0, 100),
        ])
        if (request === selectionRequest) set({ selectedTask, items })
      } catch (error) {
        if (request === selectionRequest) set({ error: errorMessage(error), selectedTask: null, items: [] })
      } finally {
        if (request === selectionRequest) set({ loading: false })
      }
    },
    refreshItems: async (status) => {
      const task = get().selectedTask
      if (!task) return
      try {
        const items = await folderTaskClient.listItems(task.id, status, 0, 100)
        if (get().selectedTask?.id === task.id) set({ items })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },
    createTask: async (input) => {
      set({ mutating: true, error: null })
      try {
        const task = await folderTaskClient.create(input)
        if (!task) return null
        set((state) => ({
          selectedTask: task,
          items: [],
          tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)],
        }))
        return task
      } catch (error) {
        set({ error: errorMessage(error) })
        return null
      } finally {
        set({ mutating: false })
      }
    },
    confirmPlan: (plan) => mutate((task) => folderTaskClient.confirmPlan(task.id, plan, task.revision)),
    resolveDecision: (input) => mutate((task) => folderTaskClient.resolveDecision({
      taskId: task.id,
      expectedRevision: task.revision,
      ...input,
    })),
    setStatus: (action) => mutate((task) => folderTaskClient.setStatus(task.id, action, task.revision)),
  }
})
