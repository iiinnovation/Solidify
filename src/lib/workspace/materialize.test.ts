import { beforeEach, describe, expect, it } from 'vitest'
import { deriveArtifactPath, normalizeArtifactPath, normalizeArtifactType } from './materialize'
import { useDocumentStore } from '@/stores/document-store'

describe('M3.5 document model', () => {
  beforeEach(() => useDocumentStore.getState().reset())

  it('derives safe workspace paths for every artifact family', () => {
    expect(deriveArtifactPath('需求/规格', 'document')).toBe('03-交付物/需求-规格.md')
    expect(deriveArtifactPath('流程', 'mermaid')).toBe('03-交付物/流程.mmd')
    expect(deriveArtifactPath('实现', 'code', '```typescript\nconst x = 1\n```')).toBe('03-交付物/实现.ts')
    expect(normalizeArtifactPath('../../outside', '规格', 'document')).toBe('03-交付物/规格.md')
    expect(normalizeArtifactPath('02-过程/notes.md', '规格', 'document')).toBe('02-过程/notes.md')
  })

  it('normalizes legacy aliases', () => {
    expect(normalizeArtifactType('diagram')).toBe('mermaid')
    expect(normalizeArtifactType('pie')).toBe('chart')
    expect(normalizeArtifactType('unknown')).toBe('document')
  })

  it('uses path as the sole document identity', () => {
    const store = useDocumentStore.getState()
    store.upsertDocument({ path: '03-交付物/a.md', title: 'A', type: 'document', content: 'one', streaming: true, version: 1 })
    store.upsertDocument({ path: '03-交付物/a.md', title: 'A', type: 'document', content: 'two', streaming: false, version: 2 })
    expect(Object.keys(useDocumentStore.getState().documents)).toEqual(['03-交付物/a.md'])
    expect(useDocumentStore.getState().documents['03-交付物/a.md'].content).toBe('two')
    expect(useDocumentStore.getState().activePath).toBe('03-交付物/a.md')
  })
})
