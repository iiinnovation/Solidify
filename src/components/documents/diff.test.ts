import { describe, expect, it } from 'vitest'
import { lineDiff } from './diff'

describe('document version diff', () => {
  it('preserves common lines and marks additions and removals', () => {
    expect(lineDiff('title\nold\nend', 'title\nnew\nend')).toEqual([
      { kind: 'same', text: 'title' },
      { kind: 'remove', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: 'end' },
    ])
  })
})
