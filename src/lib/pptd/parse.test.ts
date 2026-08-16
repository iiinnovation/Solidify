import { describe, expect, it } from 'vitest'
import { parsePptdProject, PptdParseError } from './parse'
import { validatePptdProject } from './validate'

const manifest = `version: v2\ntitle: Demo\nsize: [960, 540]\ntheme:\n  colors:\n    bg: "#000000"\n    text: "#ffffff"\n    accent: "#ffcc00"\n  textStyles:\n    title: {fontSize: 36, color: "$text"}\npages:\n  - pages/01.page\n`
const page = `pageType: cover\nbackground: {type: solid, color: "$bg"}\nelements:\n  - elementId: title\n    elementType: text\n    bounds: [48, 40, 800, 100]\n    content:\n      fontSize: 36\n      color: "$accent"\n      text: "Hello"\n`

describe('PPTD parser and validator', () => {
  it('parses a multi-file project and expands theme tokens', () => {
    const project = parsePptdProject({ manifest, pages: { 'pages/01.page': page } })
    expect(project.pages[0].background?.color).toBe('#000000')
    expect(project.pages[0].elements[0].content?.color).toBe('#ffcc00')
    expect(project.theme.textStyles.title.color).toBe('#ffffff')
    expect(validatePptdProject(project).valid).toBe(true)
  })

  it('rejects unsafe page references and missing files', () => {
    expect(() => parsePptdProject({ manifest: manifest.replace('pages/01.page', '../secret.page'), pages: {} })).toThrow(PptdParseError)
    expect(() => parsePptdProject({ manifest, pages: {} })).toThrow(/缺少页面文件/)
  })

  it('reports bounds, missing media and duplicate ids', () => {
    const project = parsePptdProject({
      manifest,
      pages: { 'pages/01.page': `${page.replace('bounds: [48, 40, 800, 100]', 'bounds: [900, 500, 100, 100]')}\n  - elementId: title\n    elementType: image\n    bounds: [1, 1, 20, 20]\n    src: media/missing.png\n` },
    })
    const result = validatePptdProject(project)
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['out-of-bounds', 'duplicate-element-id', 'missing-media']))
  })

  it('reports an unresolved variable as a warning and text overlap as an error', () => {
    const project = parsePptdProject({
      manifest,
      pages: { 'pages/01.page': `${page.replace('color: "$accent"', 'color: "$missing"')}
  - elementId: subtitle
    elementType: text
    bounds: [100, 60, 200, 40]
    content: {text: Overlap}
` },
    })
    const result = validatePptdProject(project)
    expect(project.unresolvedTokens).toEqual([{ path: 'pages/01.page', token: 'missing' }])
    expect(result.warnings.map((item) => item.code)).toContain('undefined-token')
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['text-overlap']))
    expect(result.errors.map((item) => item.code)).not.toContain('undefined-token')
  })

  it('treats $$ as a literal dollar so prose is never read as a token', () => {
    // A function replacement: `$$` in a replacement *string* would collapse to
    // a single `$` before the YAML ever sees it.
    const prose = page.replace('text: "Hello"', () => 'text: "$$USD 100 与 $$Apple 的对比"')
    const project = parsePptdProject({ manifest, pages: { 'pages/01.page': prose } })

    expect(project.pages[0].elements[0].content?.text).toBe('$USD 100 与 $Apple 的对比')
    expect(project.unresolvedTokens).toEqual([])
    expect(validatePptdProject(project).warnings.some((item) => item.code === 'undefined-token')).toBe(false)
  })

  it('does not re-resolve a dollar that an escape just produced', () => {
    const escaped = page.replace('color: "$bg"', () => 'color: "$$bg"')
    const project = parsePptdProject({ manifest, pages: { 'pages/01.page': escaped } })

    expect(project.pages[0].background?.color).toBe('$bg')
  })
})
