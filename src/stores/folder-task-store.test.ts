import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  listItems: vi.fn(),
}))

vi.mock('@/lib/folder-tasks', () => ({ folderTaskClient: client }))

import { useFolderTaskStore } from './folder-task-store'

describe('folder task store refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useFolderTaskStore.setState({
      tasks: [],
      selectedTask: null,
      items: [],
      loading: false,
      mutating: false,
      error: null,
    })
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
    expect(useFolderTaskStore.getState().items).toBe(items)
  })
})
