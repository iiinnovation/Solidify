import { beforeEach, describe, expect, it } from 'vitest'
import { buildRunTree, loadRunTree, RunLedger } from './ledger'

describe('parent-child run ledger tree', () => {
  beforeEach(() => localStorage.clear())

  it('builds a stable tree from run.started parentRunId facts', () => {
    const root = new RunLedger('tree-root')
    const first = new RunLedger('tree-root:first')
    const second = new RunLedger('tree-root:second')
    root.append('run.started', { parentRunId: null })
    first.append('run.started', { parentRunId: 'tree-root' })
    second.append('run.started', { parentRunId: 'tree-root' })

    const tree = buildRunTree([root, first, second], 'tree-root')
    expect(tree?.children.map((node) => node.runId)).toEqual(['tree-root:first', 'tree-root:second'])
  })

  it('loads persisted root and children without mixing unrelated runs', () => {
    const root = new RunLedger('persist-root')
    const child = new RunLedger('persist-root:child')
    const unrelated = new RunLedger('unrelated')
    root.append('run.started', { parentRunId: null })
    child.append('run.started', { parentRunId: 'persist-root' })
    unrelated.append('run.started', { parentRunId: null })

    const tree = loadRunTree('persist-root')
    expect(tree?.runId).toBe('persist-root')
    expect(tree?.children).toHaveLength(1)
    expect(tree?.children[0].runId).toBe('persist-root:child')
  })
})
