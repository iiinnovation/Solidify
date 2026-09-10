import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  listItems: vi.fn(),
  previewPlan: vi.fn(),
  confirmPlan: vi.fn(),
  resolveDecision: vi.fn(),
  reviewItems: vi.fn(),
  delete: vi.fn(),
  setStatus: vi.fn(),
}))

vi.mock('@/lib/folder-tasks', () => ({ folderTaskClient: client }))

import { useFolderTaskStore } from './folder-task-store'

describe('folder task store refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    useFolderTaskStore.setState({
      tasks: [],
      selectedTask: null,
      planPreview: null,
      items: [],
      itemsLoading: false,
      itemsHasMore: false,
      loading: false,
      mutating: false,
      stoppingTaskId: null,
      stopDelayed: false,
      error: null,
      itemStatus: undefined,
    })
  })

  it('keeps stopping visible until backend confirmation and scopes delay events to the task', async () => {
    const running = { id: 'task-stop', status: 'running', revision: 1 }
    const paused = { ...running, status: 'paused', revision: 2 }
    useFolderTaskStore.setState({ selectedTask: running as never, tasks: [running as never] })
    let resolve!: (value: unknown) => void
    client.setStatus.mockReturnValue(new Promise((done) => { resolve = done }))
    client.listItems.mockResolvedValue([])
    const request = useFolderTaskStore.getState().setStatus('pause')
    expect(useFolderTaskStore.getState().stoppingTaskId).toBe('task-stop')
    expect(useFolderTaskStore.getState().selectedTask?.status).toBe('running')
    useFolderTaskStore.getState().reportStopDelay('other-task')
    expect(useFolderTaskStore.getState().stopDelayed).toBe(false)
    useFolderTaskStore.getState().reportStopDelay('task-stop')
    expect(useFolderTaskStore.getState().stopDelayed).toBe(true)
    resolve(paused)
    await request
    expect(useFolderTaskStore.getState().selectedTask?.status).toBe('paused')
    expect(useFolderTaskStore.getState().stoppingTaskId).toBeNull()
    expect(useFolderTaskStore.getState().stopDelayed).toBe(false)
  })

  it('reloads the selected detail and items after an Agent batch updates SQLite', async () => {
    const stale = { id: 'task-1', status: 'running', revision: 1 }
    const fresh = {
      id: 'task-1',
      status: 'awaiting_decision',
      revision: 4,
      decisions: [{ id: 'decision-1', status: 'pending' }],
    }
    const items = [{ id: 'item-1', status: 'pending_decision' }]
    useFolderTaskStore.setState({ selectedTask: stale as never })
    client.list.mockResolvedValue([fresh])
    client.get.mockResolvedValue(fresh)
    client.listItems.mockResolvedValue(items)

    await useFolderTaskStore.getState().refresh()

    expect(client.get).toHaveBeenCalledWith('task-1')
    expect(useFolderTaskStore.getState().selectedTask).toBe(fresh)
    expect(useFolderTaskStore.getState().items).toEqual(items)
  })

  it('preserves the active filter and loaded page size during polling', async () => {
    const selected = { id: 'filtered-task', status: 'running', revision: 1 }
    useFolderTaskStore.setState({ selectedTask: selected as never, itemStatus: 'failed', items: Array.from({ length: 200 }, (_, i) => ({ id: String(i) })) as never })
    client.list.mockResolvedValue([selected])
    client.get.mockResolvedValue(selected)
    client.listItems.mockResolvedValue([])
    await useFolderTaskStore.getState().refresh()
    expect(client.listItems).toHaveBeenCalledWith('filtered-task', 'failed', 0, 200)
  })

  it('hands the recommended start to semantic planning without confirming defaults', async () => {
    const selected = { id: 'planning-task', status: 'awaiting_plan_confirmation', decisions: [], inventory: { readableFiles: 3 } }
    useFolderTaskStore.setState({ selectedTask: selected as never })
    await expect(useFolderTaskStore.getState().startRecommended()).resolves.toBe(selected)
    expect(client.previewPlan).not.toHaveBeenCalled()
    expect(client.confirmPlan).not.toHaveBeenCalled()
  })

  it('allows OCR-only inventory into planning without inferring scope for legacy images', async () => {
    const selected = { id: 'images', status: 'awaiting_plan_confirmation', decisions: [],
      inventory: { readableFiles: 0, externalFiles: 2 } }
    useFolderTaskStore.setState({ selectedTask: selected as never })
    await expect(useFolderTaskStore.getState().startRecommended()).resolves.toBe(selected)
    expect(client.resolveDecision).not.toHaveBeenCalled()
    const legacy = { ...selected, inventory: { readableFiles: 0, extensionCounts: { png: 2 } } }
    useFolderTaskStore.setState({ selectedTask: legacy as never })
    await expect(useFolderTaskStore.getState().startRecommended()).resolves.toBeNull()
    expect(useFolderTaskStore.getState().error).toContain('没有当前可解析')
  })

  it('keeps the second page visible after saving a result on that page', async () => {
    const task = { id: 'review-pages', status: 'reviewing', revision: 1 }
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }))
    useFolderTaskStore.setState({ selectedTask: task as never, items: items as never, itemStatus: 'completed' })
    client.reviewItems.mockResolvedValue({ ...task, revision: 2 })
    client.listItems.mockResolvedValue(items)
    await useFolderTaskStore.getState().reviewItems([{ itemId: '150', action: 'accept', result: { summary: 'fixed' } }])
    expect(client.listItems).toHaveBeenCalledWith(task.id, 'completed', 0, 200)
    expect(useFolderTaskStore.getState().items).toHaveLength(200)
    expect(useFolderTaskStore.getState().itemsLoading).toBe(false)
  })

  it('blocks pagination during filter changes and ignores an older same-filter response', async () => {
    const task = { id: 'filter-race' }
    useFolderTaskStore.setState({ selectedTask: task as never, items: [{ id: 'old', status: 'completed' }] as never, itemsHasMore: true })
    let resolveOld!: (items: unknown[]) => void
    client.listItems.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    const old = useFolderTaskStore.getState().refreshItems('failed')
    await useFolderTaskStore.getState().loadMoreItems('failed')
    expect(client.listItems).toHaveBeenCalledTimes(1)
    expect(useFolderTaskStore.getState().items).toEqual([])
    client.listItems.mockResolvedValueOnce([])
    await useFolderTaskStore.getState().refreshItems('completed')
    client.listItems.mockResolvedValueOnce([{ id: 'fresh', status: 'failed' }])
    await useFolderTaskStore.getState().refreshItems('failed')
    resolveOld([{ id: 'stale', status: 'failed' }])
    await old
    expect(useFolderTaskStore.getState().items.map((item) => item.id)).toEqual(['fresh'])
    expect(useFolderTaskStore.getState().itemsLoading).toBe(false)
  })

  it('does not let an earlier poll discard a newly loaded page', async () => {
    const task = { id: 'poll-race', status: 'running' }
    const first = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))
    useFolderTaskStore.setState({ selectedTask: task as never, items: first as never, itemsHasMore: true })
    client.list.mockResolvedValue([task])
    client.get.mockResolvedValue(task)
    let resolvePoll!: (items: unknown[]) => void
    client.listItems.mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve }))
    const poll = useFolderTaskStore.getState().refresh()
    client.listItems.mockResolvedValueOnce([{ id: 'next' }])
    await useFolderTaskStore.getState().loadMoreItems()
    resolvePoll(first)
    await poll
    expect(useFolderTaskStore.getState().items).toHaveLength(101)
    expect(useFolderTaskStore.getState().items.at(-1)?.id).toBe('next')
  })

  it('applies review mutations with the selected optimistic revision', async () => {
    const selected = { id: 'task-1', status: 'reviewing', revision: 7 }
    const updated = { ...selected, revision: 8 }
    useFolderTaskStore.setState({ selectedTask: selected as never })
    client.reviewItems.mockResolvedValue(updated)
    client.listItems.mockResolvedValue([])

    await useFolderTaskStore.getState().reviewItems([{ itemId: 'item-1', action: 'retry' }])

    expect(client.reviewItems).toHaveBeenCalledWith('task-1', [{ itemId: 'item-1', action: 'retry' }], 7)
    expect(useFolderTaskStore.getState().selectedTask).toBe(updated)
  })

  it('reports a rejected result mutation without claiming it was saved', async () => {
    const selected = { id: 'task-1', status: 'reviewing', revision: 7 }
    useFolderTaskStore.setState({ selectedTask: selected as never })
    client.reviewItems.mockRejectedValue(new Error('结果不符合已确认字段'))
    client.get.mockResolvedValue(selected)
    client.listItems.mockResolvedValue([])

    await expect(useFolderTaskStore.getState().reviewItems([
      { itemId: 'item-1', action: 'accept', result: {} },
    ])).resolves.toBe(false)

    expect(useFolderTaskStore.getState().error).toBe('结果不符合已确认字段')
  })

  it('does not replace a newly selected task when an older mutation finishes', async () => {
    const first = { id: 'task-1', status: 'reviewing', revision: 7 }
    const updatedFirst = { ...first, revision: 8 }
    const second = { id: 'task-2', status: 'paused', revision: 3 }
    let resolveReview!: (task: typeof updatedFirst) => void
    client.reviewItems.mockReturnValue(new Promise((resolve) => { resolveReview = resolve }))
    useFolderTaskStore.setState({ selectedTask: first as never, tasks: [first, second] as never[] })

    const mutation = useFolderTaskStore.getState().reviewItems([{ itemId: 'item-1', action: 'accept', result: {} }])
    useFolderTaskStore.setState({ selectedTask: second as never, items: [{ id: 'item-2' } as never] })
    resolveReview(updatedFirst)
    await mutation

    expect(useFolderTaskStore.getState().selectedTask).toBe(second)
    expect(useFolderTaskStore.getState().items).toEqual([{ id: 'item-2' }])
    expect(useFolderTaskStore.getState().tasks[0]).toBe(updatedFirst)
    expect(client.listItems).not.toHaveBeenCalled()
  })

  it('requires a bound preview token before confirming a plan', async () => {
    const selected = { id: 'task-1', status: 'awaiting_plan_confirmation', revision: 7 }
    const plan = { schemaVersion: 3 }
    const preview = { confirmationToken: 'confirm-abc', plan }
    const updated = { ...selected, status: 'running', revision: 8 }
    useFolderTaskStore.setState({ selectedTask: selected as never })
    client.previewPlan.mockResolvedValue(preview)
    client.confirmPlan.mockResolvedValue(updated)
    client.listItems.mockResolvedValue([])

    await useFolderTaskStore.getState().previewPlan(plan as never)
    await useFolderTaskStore.getState().confirmPlan()

    expect(client.previewPlan).toHaveBeenCalledWith('task-1', plan, 7)
    expect(client.confirmPlan).toHaveBeenCalledWith('task-1', 'confirm-abc', 7)
  })

  it('automatically skips technical incompatibilities before handing planning to chat', async () => {
    const plan = { output: { format: 'json', relativePath: '.solidify/out.json', overwrite: false, autoWrite: false } }
    const created = {
      id: 'task-new', revision: 1, status: 'awaiting_plan_confirmation', plan,
      decisions: [{ id: 'format-1', kind: 'unsupported_formats', status: 'pending' }],
    }
    const resolved = { ...created, revision: 2, decisions: [] }
    client.create.mockResolvedValue(created)
    client.resolveDecision.mockResolvedValue(resolved)

    await expect(useFolderTaskStore.getState().createTask({
      name: '提取合同', goal: '提取合同金额', recipe: 'structured-extraction',
    })).resolves.toBe(resolved)

    expect(client.resolveDecision).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-new', decisionId: 'format-1', optionId: 'skip', applyToSimilar: true, expectedRevision: 1,
    }))
    expect(client.previewPlan).not.toHaveBeenCalled()
    expect(client.confirmPlan).not.toHaveBeenCalled()
    expect(useFolderTaskStore.getState().selectedTask).toBe(resolved)
  })

  it('deletes the selected durable task and clears its projection', async () => {
    const selected = { id: 'task-1', revision: 3 }
    useFolderTaskStore.setState({ selectedTask: selected as never, tasks: [selected as never], items: [{ id: 'item-1' } as never] })
    client.delete.mockResolvedValue(undefined)

    await expect(useFolderTaskStore.getState().deleteTask()).resolves.toBe(true)
    expect(client.delete).toHaveBeenCalledWith('task-1', 3)
    expect(useFolderTaskStore.getState()).toMatchObject({ selectedTask: null, tasks: [], items: [] })
  })

  it('does not re-query a task from the stale route after deletion', async () => {
    const selected = { id: 'task-deleted-route', revision: 3 }
    useFolderTaskStore.setState({ selectedTask: selected as never, tasks: [selected as never] })
    client.delete.mockResolvedValue(undefined)

    await useFolderTaskStore.getState().deleteTask()
    await useFolderTaskStore.getState().select('task-deleted-route')

    expect(client.get).not.toHaveBeenCalled()
    expect(useFolderTaskStore.getState().error).toBeNull()
  })

  it('ignores an older refresh that observes the task after it was deleted', async () => {
    const selected = { id: 'task-deleted-during-refresh', revision: 3 }
    let rejectGet!: (error: Error) => void
    client.list.mockResolvedValue([selected])
    client.get.mockReturnValue(new Promise((_resolve, reject) => { rejectGet = reject }))
    client.listItems.mockResolvedValue([])
    client.delete.mockResolvedValue(undefined)
    useFolderTaskStore.setState({ selectedTask: selected as never, tasks: [selected as never] })

    const refresh = useFolderTaskStore.getState().refresh()
    await useFolderTaskStore.getState().deleteTask()
    rejectGet(new Error('Folder task was not found'))
    await refresh

    expect(useFolderTaskStore.getState()).toMatchObject({
      selectedTask: null,
      error: null,
      loading: false,
    })
  })
})
