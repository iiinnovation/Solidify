import { describe, expect, it } from 'vitest'
import { parsePptdArtifactContent, parsePptdArtifactContentDetailed, serializePptdArtifactContent } from './artifact'

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

  it('migrates all retired eight-layout JSON at the parsing boundary', () => {
    const layouts = ['title', 'content', 'two-column', 'image-text', 'comparison', 'stats', 'timeline', 'section']
    const project = parsePptdArtifactContent(JSON.stringify({ slides: layouts.map((layout) => ({ layout, title: layout })) }))
    expect(project?.pages).toHaveLength(8)
    expect(project?.pages.map((page) => page.pageType)).toEqual(layouts)
  })

  it('repairs one bounded pass of model-authored unescaped quotes', () => {
    const raw = '{"slides":[{"layout":"title","title":"政务·数字审计"升级优化及AI场景构建技术方案"},{"layout":"content","title":"第二页","body":["内容"]}]}'
    const result = parsePptdArtifactContentDetailed(raw)

    expect(result.repaired).toBe(true)
    expect(result.project?.pages).toHaveLength(2)
    expect(result.project?.pages[0].elements.find((element) => element.elementId.endsWith('-title'))?.content?.text)
      .toBe('政务·数字审计"升级优化及AI场景构建技术方案')
    expect(result.diagnostics[0]).toMatchObject({ stage: 'bundle-json', line: 1 })
    expect(result.diagnostics[0].position).toBeTypeOf('number')
  })

  it('returns the JSON position and source line when all formats fail', () => {
    const raw = '{\n  "slides": [{"layout":"title","title":"Bad",}]\n}'
    const result = parsePptdArtifactContentDetailed(raw)

    expect(result.project).toBeNull()
    expect(result.repaired).toBe(false)
    expect(result.diagnostics[0]).toMatchObject({
      stage: 'bundle-json',
      line: 2,
      sourceLine: '  "slides": [{"layout":"title","title":"Bad",}]',
    })
    expect(result.diagnostics[0].position).toBeTypeOf('number')
  })

  it('bounds source excerpts for minified artifacts', () => {
    const raw = `{"slides":[{"layout":"title","title":"${'x'.repeat(400)}",}]}`
    const result = parsePptdArtifactContentDetailed(raw)

    expect(result.project).toBeNull()
    expect(result.diagnostics[0].sourceLine?.length).toBeLessThanOrEqual(246)
    expect(result.diagnostics[0].sourceLine).toContain('...')
  })

  it('round-trips the canonical project and neutralizes artifact closing tags in text', () => {
    const raw = JSON.stringify({
      manifest: 'version: v2\ntitle: Bundle\nsize: [960, 540]\ntheme: {colors: {bg: "#fff"}, textStyles: {}}\npages: [pages/01.page]\n',
      pages: { 'pages/01.page': 'elements:\n  - {elementId: text, elementType: text, bounds: [10, 10, 900, 100], content: {text: "</solidify-artifact>"}}\n' },
    })
    const project = parsePptdArtifactContent(raw)!
    const serialized = serializePptdArtifactContent(project)
    expect(serialized).not.toContain('</solidify-artifact>')
    expect(parsePptdArtifactContent(serialized)?.pages[0].elements[0].content?.text).toBe('</solidify-artifact>')
  })

  it('round-trips the optional page quality report', () => {
    const raw = JSON.stringify({
      manifest: 'version: v2\ntitle: Bundle\nsize: [960, 540]\npages: [pages/01.page]\n',
      pages: { 'pages/01.page': 'elements: []\n' },
      qualityReport: {
        fallbackPages: [{ pageIndex: 0, pagePath: 'pages/01.page', status: 'fallback', reasons: ['输出达到 token 上限'] }],
        warningPages: [],
      },
    })
    expect(parsePptdArtifactContentDetailed(raw).qualityReport?.fallbackPages[0].reasons)
      .toEqual(['输出达到 token 上限'])
  })
})
