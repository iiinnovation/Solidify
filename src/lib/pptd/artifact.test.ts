import { describe, expect, it } from 'vitest'
import { parsePptdArtifactContent } from './artifact'

describe('PPTD artifact bundle', () => {
  it('parses the canonical JSON bundle', () => {
    const project = parsePptdArtifactContent(JSON.stringify({
      manifest: 'version: v2\ntitle: Bundle\nsize: [960, 540]\npages: [pages/01.page]\n',
      pages: { 'pages/01.page': 'elements: []\n' },
    }))
    expect(project?.title).toBe('Bundle')
  })

  it('accepts inline YAML pages for model-generated artifacts', () => {
    const project = parsePptdArtifactContent(`version: v2\ntitle: Inline\nsize: [960, 540]\ntheme: {colors: {bg: '#fff'}, textStyles: {}}\npages:\n  - elements: []\n`)
    expect(project?.pages).toHaveLength(1)
    expect(project?.pagePaths[0]).toBe('pages/01.page')
  })
})
